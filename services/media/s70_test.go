package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/interceptor"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media/oggwriter"
)

func TestDownSequenceForwardsLateAndSettlesMissing(t *testing.T) {
	r := &room{}
	type step struct {
		seq             uint32
		late, forwarded bool
	}
	for _, s := range []step{
		{100, false, true},
		{103, false, true},  // 101, 102 missing
		{101, true, true},   // late, fills a gap
		{101, false, false}, // duplicate of a late packet
		{103, false, false}, // duplicate of the newest
		{160, false, true},  // 104..159 missing (56)
		{109, false, false}, // 51 behind: too old
		{110, true, true},   // 50 behind: edge of the window
	} {
		late, forwarded := r.acceptDownSequence(s.seq)
		if late != s.late || forwarded != s.forwarded {
			t.Fatalf("seq %d: late=%v forwarded=%v want %v %v", s.seq, late, forwarded, s.late, s.forwarded)
		}
	}
	got := r.transport
	// Never filled: 102, 104..109, 111..159 = 1 + 6 + 49.
	if got.DownSequenceMissing != 56 || got.DownLateForwarded != 2 || got.DownLate != 3 || got.DownDuplicate != 2 || got.DownOutOfOrderDrop != 3 {
		t.Fatalf("counters %+v", got)
	}
	// A leg replacement resets the window; uint32 wrap is forward progress.
	r = &room{}
	r.acceptDownSequence(0xffffffff)
	if late, ok := r.acceptDownSequence(1); late || !ok || r.transport.DownSequenceMissing != 1 {
		t.Fatalf("wrap: late=%v ok=%v %+v", late, ok, r.transport)
	}
	if late, ok := r.acceptDownSequence(0); !late || !ok || r.transport.DownSequenceMissing != 0 {
		t.Fatalf("late across wrap: late=%v ok=%v %+v", late, ok, r.transport)
	}
	// A straggler from before the first packet never under-counts.
	if _, ok := r.acceptDownSequence(0xfffffffe); ok || r.transport.DownSequenceMissing != 0 {
		t.Fatalf("pre-start straggler forwarded: %+v", r.transport)
	}
}

// blockingWriter parks the recorder goroutine on its first write.
type blockingWriter struct {
	entered chan struct{}
	release chan struct{}
	once    sync.Once
	mu      sync.Mutex
	buf     bytes.Buffer
}

func (w *blockingWriter) Write(p []byte) (int, error) {
	w.once.Do(func() {
		close(w.entered)
		<-w.release
	})
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.buf.Write(p)
}
func (w *blockingWriter) Close() error { return nil }

func testOgg(t *testing.T) *oggwriter.OggWriter {
	t.Helper()
	w, err := oggwriter.NewWith(io.Discard, 48000, 1)
	if err != nil {
		t.Fatal(err)
	}
	return w
}

func TestRecordingQueueFullDropsAndCounts(t *testing.T) {
	timeline := &blockingWriter{entered: make(chan struct{}), release: make(chan struct{})}
	r := &room{created: time.Now()}
	r.recorder = startRoomRecorder(testOgg(t), testOgg(t), timeline, recordingQueueSize)
	packet := &rtp.Packet{Header: rtp.Header{Version: 2, Timestamp: 960}, Payload: []byte{0xf8, 0xff, 0xfe}}
	r.record(r.recorder.down, packet, "remote_original", 1, 0, 20, false)
	<-timeline.entered // the writer holds job 1; the queue is empty again
	for i := 0; i < recordingQueueSize; i++ {
		r.record(r.recorder.up, packet, "caller_original", uint32(i), 0, 20, false)
	}
	if r.transport.RecordingDrops != 0 {
		t.Fatalf("dropped before the queue was full: %d", r.transport.RecordingDrops)
	}
	r.record(r.recorder.up, packet, "caller_original", 9999, 0, 20, true)
	if r.transport.RecordingDrops != 1 {
		t.Fatalf("full queue did not drop: %d", r.transport.RecordingDrops)
	}
	close(timeline.release)
	r.recorder.close()
	if r.recorder.failed || r.recorder.downPackets.Load() != 1 || r.recorder.upPackets.Load() != recordingQueueSize {
		t.Fatalf("drained %+v", r.recorder)
	}
	if lines := strings.Count(timeline.buf.String(), "\n"); lines != recordingQueueSize+1 {
		t.Fatalf("timeline lines=%d", lines)
	}
}

// A late packet is written to the timeline with late:true but never to the Ogg,
// and closeRoom finalizes only after the writer has drained.
func TestLatePacketIsTimelineOnlyAndCloseDrainsBeforeManifest(t *testing.T) {
	b := &bridge{rooms: map[string]*room{}, recordDir: t.TempDir()}
	id := "70707070-7070-7070-7070-707070707070"
	r, err := b.getRoom(id)
	if err != nil {
		t.Fatal(err)
	}
	payload := []byte{0xf8, 0xff, 0xfe}
	r.mu.Lock()
	for _, step := range []struct {
		seq  uint32
		late bool
	}{{1, false}, {3, false}, {2, true}} {
		for _, direction := range []string{"remote_original", "caller_original"} {
			ogg := r.recorder.down
			if direction == "caller_original" {
				ogg = r.recorder.up
			}
			r.record(ogg, &rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: uint16(step.seq), Timestamp: step.seq * 960}, Payload: payload}, direction, step.seq, uint64(step.seq)*20000, 20, step.late)
		}
	}
	r.mu.Unlock()
	b.closeRoom(id, "test")
	if r.downPackets != 2 || r.upPackets != 2 {
		t.Fatalf("late packet reached the Ogg: down=%d up=%d", r.downPackets, r.upPackets)
	}
	raw, err := os.ReadFile(filepath.Join(b.recordDir, id, "timeline.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
	if len(lines) != 6 {
		t.Fatalf("timeline lines=%d", len(lines))
	}
	for index, line := range lines {
		var entry map[string]any
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			t.Fatal(err)
		}
		_, late := entry["late"]
		if late != (index >= 4) || (late && entry["late"] != true) {
			t.Fatalf("line %d late flag: %s", index, line)
		}
	}
	var manifest recordingManifest
	manifestRaw, err := os.ReadFile(filepath.Join(b.recordDir, id, "manifest.json"))
	if err != nil || json.Unmarshal(manifestRaw, &manifest) != nil || !manifest.Complete {
		t.Fatalf("manifest %v %s", err, manifestRaw)
	}
	for _, artifact := range manifest.Artifacts {
		if artifact.Name == "timeline.jsonl" && artifact.Bytes != int64(len(raw)) {
			t.Fatalf("manifest hashed a timeline still being written: %d != %d", artifact.Bytes, len(raw))
		}
	}
	stats, err := os.ReadFile(filepath.Join(b.recordDir, id, "transport-stats.json"))
	if err != nil || !strings.Contains(string(stats), `"recordingDrops":0`) || !strings.Contains(string(stats), `"downLateForwarded":0`) || !strings.Contains(string(stats), `"downSequenceMissing":0`) {
		t.Fatalf("transport stats keys: %v %s", err, stats)
	}
}

func TestRaiseFractionLostFloorsReceiverAndSenderReports(t *testing.T) {
	floor := lossFloorFraction(5)
	if floor != 12 || lossFloorFraction(9) != 23 || lossFloorFraction(0) != 0 {
		t.Fatalf("fractions %d %d", floor, lossFloorFraction(9))
	}
	rr := &rtcp.ReceiverReport{Reports: []rtcp.ReceptionReport{{SSRC: 1, FractionLost: 0}, {SSRC: 2, FractionLost: 40}}}
	sr := &rtcp.SenderReport{Reports: []rtcp.ReceptionReport{{SSRC: 3, FractionLost: 3}}}
	pli := &rtcp.PictureLossIndication{MediaSSRC: 4}
	compound := &rtcp.CompoundPacket{&rtcp.ReceiverReport{Reports: []rtcp.ReceptionReport{{SSRC: 5}}}}
	var written []rtcp.Packet
	writer := (&rtcpLossFloor{fraction: floor}).BindRTCPWriter(interceptor.RTCPWriterFunc(func(pkts []rtcp.Packet, _ interceptor.Attributes) (int, error) {
		written = pkts
		return 0, nil
	}))
	if _, err := writer.Write([]rtcp.Packet{rr, sr, pli, compound}, nil); err != nil {
		t.Fatal(err)
	}
	if len(written) != 4 || rr.Reports[0].FractionLost != 12 || rr.Reports[1].FractionLost != 40 || sr.Reports[0].FractionLost != 12 || (*compound)[0].(*rtcp.ReceiverReport).Reports[0].FractionLost != 12 {
		t.Fatalf("floor not applied as max(actual, floor): rr=%+v sr=%+v compound=%+v", rr.Reports, sr.Reports, (*compound)[0])
	}
	// The rewritten packet still marshals (the transport serializes it next).
	if _, err := rtcp.Marshal(written[:3]); err != nil {
		t.Fatal(err)
	}
}

func TestS70EnvParsing(t *testing.T) {
	for raw, want := range map[string]uint8{"": 0, "0": 0, "1": 1, "5": 5, "9": 9} {
		if got, err := configuredRRLossFloorPct(raw); err != nil || got != want {
			t.Fatalf("floor %q: %d %v", raw, got, err)
		}
	}
	for _, raw := range []string{"10", "50", "-1", "5%", " 5", "x"} {
		if _, err := configuredRRLossFloorPct(raw); err == nil {
			t.Fatalf("floor %q accepted", raw)
		}
	}
	for raw, want := range map[string]uint64{"": 0, "0": 0, "2": 2, "20": 20} {
		if got, err := configuredTestDropEveryN(raw); err != nil || got != want {
			t.Fatalf("drop %q: %d %v", raw, got, err)
		}
	}
	for _, raw := range []string{"1", "-2", "x", "2.5"} {
		if _, err := configuredTestDropEveryN(raw); err == nil {
			t.Fatalf("drop %q accepted", raw)
		}
	}
	off := &bridge{}
	every20 := &bridge{testDropEveryN: 20}
	drops := 0
	for received := uint64(1); received <= 100; received++ {
		if off.testDrop(received) {
			t.Fatal("drop knob off still drops")
		}
		if every20.testDrop(received) {
			drops++
		}
	}
	if drops != 5 {
		t.Fatalf("every 20th of 100 dropped %d", drops)
	}
}

// End to end: a floored peer's RTCP reaches the RTP sender with FractionLost at
// the floor on a lossless loopback, while the unfloored control reports 0.
func TestLossFloorReachesRTPSenderReceiverReport(t *testing.T) {
	for _, tc := range []struct {
		floor  uint8
		tuning sctpTuning
		want   uint8
	}{{0, sctpTuning{}, 0}, {5, sctpTuning{}, 12}, {5, sctpTuning{name: "v1", minCwnd: sctpTuningV1MinCwnd, rtoMax: sctpTuningV1RTOMax}, 12}, {0, sctpTuning{dtlsFlight: 100 * time.Millisecond}, 0}, {5, sctpTuning{dtlsFlight: 100 * time.Millisecond}, 12}} {
		name := tc.tuning.label() + "-" + string(rune('0'+tc.floor))
		if tc.tuning.dtlsFlight > 0 {
			name += "-dtls" // the answerer is the DTLS client whose flight interval this sets
		}
		t.Run(name, func(t *testing.T) {
			sender, err := webrtc.NewPeerConnection(webrtc.Configuration{})
			if err != nil {
				t.Fatal(err)
			}
			defer sender.Close()
			receiver, err := newMediaPeerConnection(tc.tuning, tc.floor, webrtc.Configuration{})
			if err != nil {
				t.Fatal(err)
			}
			defer receiver.Close()
			track, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2}, "mic", "client")
			if err != nil {
				t.Fatal(err)
			}
			rtpSender, err := sender.AddTrack(track)
			if err != nil {
				t.Fatal(err)
			}
			receiver.OnTrack(func(remote *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
				for {
					if _, _, err := remote.ReadRTP(); err != nil {
						return
					}
				}
			})
			offer, err := sender.CreateOffer(nil)
			if err != nil {
				t.Fatal(err)
			}
			gather := webrtc.GatheringCompletePromise(sender)
			if err = sender.SetLocalDescription(offer); err != nil {
				t.Fatal(err)
			}
			<-gather
			if err = receiver.SetRemoteDescription(*sender.LocalDescription()); err != nil {
				t.Fatal(err)
			}
			answer, err := receiver.CreateAnswer(nil)
			if err != nil {
				t.Fatal(err)
			}
			gather = webrtc.GatheringCompletePromise(receiver)
			if err = receiver.SetLocalDescription(answer); err != nil {
				t.Fatal(err)
			}
			<-gather
			if err = sender.SetRemoteDescription(*receiver.LocalDescription()); err != nil {
				t.Fatal(err)
			}
			reports := make(chan uint8, 16)
			go func() {
				for {
					pkts, _, err := rtpSender.ReadRTCP()
					if err != nil {
						return
					}
					for _, p := range pkts {
						if rr, ok := p.(*rtcp.ReceiverReport); ok && len(rr.Reports) > 0 {
							select {
							case reports <- rr.Reports[0].FractionLost:
							default:
							}
						}
					}
				}
			}()
			stop := make(chan struct{})
			defer close(stop)
			go func() {
				ticker := time.NewTicker(20 * time.Millisecond)
				defer ticker.Stop()
				for seq := uint16(1); ; seq++ {
					select {
					case <-stop:
						return
					case <-ticker.C:
					}
					_ = track.WriteRTP(&rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: seq, Timestamp: uint32(seq) * 960}, Payload: []byte{0xf8, 0xff, 0xfe}})
				}
			}()
			select {
			case got := <-reports:
				if got != tc.want {
					t.Fatalf("RR FractionLost=%d want %d", got, tc.want)
				}
			case <-time.After(15 * time.Second): // loopback ICE here takes up to ~7 s
				t.Fatalf("no receiver report reached the sender (sender=%s receiver=%s)", sender.ConnectionState(), receiver.ConnectionState())
			}
		})
	}
}

// Through the bridge: the floored peer carries a full round trip, and the drop
// knob skips exactly every Nth up packet after recording.
func TestEncryptedBridgeRoundTripWithLossFloorAndTestDrop(t *testing.T) {
	secret := bytes.Repeat([]byte("q"), 32)
	b := &bridge{rooms: map[string]*room{}, verifier: GrantVerifier{Secret: secret}, recordDir: t.TempDir(), rrLossFloorPct: 5, testDropEveryN: 2}
	server := httptest.NewServer(http.HandlerFunc(b.offer))
	defer server.Close()
	id := "70707070-7070-7070-7070-707070707071"
	defer b.closeRoom(id, "test")
	runBridgeRoundTrip(t, server.URL, id, secret, webrtc.Configuration{})
	b.mu.Lock()
	r := b.rooms[id]
	b.mu.Unlock()
	r.mu.Lock()
	stats := r.transport
	r.mu.Unlock()
	// Every even-numbered packet is a test drop unless an earlier gate took it.
	other := stats.UpChannelUnavailable + stats.UpBackpressureDrops
	if stats.UpReceived == 0 || stats.UpTestDrops > stats.UpReceived/2 || stats.UpTestDrops+other < stats.UpReceived/2 || stats.UpSent+stats.UpTestDrops+other != stats.UpReceived {
		t.Fatalf("drop knob: %+v", stats)
	}
}

// A hole in the up source timeline becomes the same number of skipped bridge
// sequences, in whole frames of the previous packet's length, capped per hole.
func TestUpSourceGapCountsWholeMissingFrames(t *testing.T) {
	for _, tc := range []struct {
		prev        uint64
		dur         uint16
		ts          uint64
		want        uint32
		description string
	}{
		{0, 20, 20000, 0, "contiguous"},
		{0, 20, 40000, 1, "one frame lost"},
		{0, 20, 80000, 3, "three frame burst"},
		{0, 20, 39999, 0, "partial frame is not a loss"},
		{1000, 10, 31000, 2, "10 ms frames"},
		{0, 60, 120000, 1, "60 ms frames"},
		{0, 20, 20000 * 100, maxUpSourceGap, "capped below the stream reset gap"},
		{0, 0, 40000, 0, "no previous duration"},
		{40000, 20, 40000, 0, "same timestamp"},
		{60000, 20, 40000, 0, "backwards"},
	} {
		if got := upSourceGap(tc.prev, tc.dur, tc.ts); got != tc.want {
			t.Fatalf("%s: upSourceGap(%d, %d, %d)=%d want %d", tc.description, tc.prev, tc.dur, tc.ts, got, tc.want)
		}
	}
	if maxUpSourceGap+1 >= 50 {
		t.Fatal("the largest skip must stay under the gateways' 50-sequence stream reset")
	}
}

// DownMaxSourceLagMillis is measured from the gateway leg's first forwarded packet
// and restarts with a new gateway leg.
func TestDownMaxSourceLagFollowsGatewayLeg(t *testing.T) {
	r := &room{}
	r.observeDownLag(5_000_000, 100_000) // first packet: the reference only
	r.observeDownLag(5_020_000, 120_000) // on time
	r.observeDownLag(5_040_000, 150_000) // 10 ms behind
	r.observeDownLag(5_060_000, 145_000) // early
	if r.transport.DownMaxSourceLagMillis != 10 {
		t.Fatalf("lag %d", r.transport.DownMaxSourceLagMillis)
	}
	r.clearLegLocked("gateway")
	r.observeDownLag(0, 10_000_000) // a rejoined leg: new reference, no 10 s lag
	r.observeDownLag(20_000, 10_045_000)
	if r.transport.DownMaxSourceLagMillis != 25 {
		t.Fatalf("lag after a new gateway leg %d", r.transport.DownMaxSourceLagMillis)
	}
}

func TestDTLSFlightEnvParsing(t *testing.T) {
	for raw, want := range map[string]time.Duration{"": 0, "0": 0, "50": 50 * time.Millisecond, "200": 200 * time.Millisecond, "1000": time.Second} {
		if got, err := configuredDTLSFlight(raw); err != nil || got != want {
			t.Fatalf("dtls flight %q: %v %v", raw, got, err)
		}
	}
	for _, raw := range []string{"1", "49", "1001", "-1", "x", "200ms", " 200", "1.5"} {
		if _, err := configuredDTLSFlight(raw); err == nil {
			t.Fatalf("dtls flight %q accepted", raw)
		}
	}
}

// Through the bridge: frames lost before the bridge skip bridge sequences (a single
// loss by 2, a 3-frame burst by 4) so the gateway's FEC sees them, while BWE padding
// (an RTP sequence with no new timestamp) skips nothing. The client's Sender Reports
// reach the bridge's report interceptor, so its Receiver Reports carry LSR.
func TestUpSequenceSkipsSourceGapsNotPaddingAndReceiverReportsCarryLSR(t *testing.T) {
	secret := bytes.Repeat([]byte("g"), 32)
	b := &bridge{rooms: map[string]*room{}, verifier: GrantVerifier{Secret: secret}, recordDir: t.TempDir()}
	server := httptest.NewServer(http.HandlerFunc(b.offer))
	defer server.Close()
	id := "70707070-7070-7070-7070-707070707072"
	defer b.closeRoom(id, "test")

	gateway, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer gateway.Close()
	ordered, retries := false, uint16(0)
	dc, err := gateway.CreateDataChannel("cellular-opus-v1", &webrtc.DataChannelInit{Ordered: &ordered, MaxRetransmits: &retries})
	if err != nil {
		t.Fatal(err)
	}
	opened := make(chan struct{})
	dc.OnOpen(func() { close(opened) })
	var mu sync.Mutex
	seqAt := map[uint64]uint32{} // source timestamp -> bridge sequence
	dc.OnMessage(func(m webrtc.DataChannelMessage) {
		if p, e := decodePacket(m.Data); e == nil {
			mu.Lock()
			seqAt[p.TimestampUS] = p.Sequence
			mu.Unlock()
		}
	})
	if code := postOffer(t, server.URL, id, "gateway", "s70e-gateway-nonce-0001", secret, gateway, true); code != 200 {
		t.Fatalf("gateway offer: %d", code)
	}
	select {
	case <-opened:
	case <-time.After(5 * time.Second):
		t.Fatal("gateway DataChannel did not open")
	}

	client, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	track, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2}, "mic", "client")
	if err != nil {
		t.Fatal(err)
	}
	sender, err := client.AddTrack(track)
	if err != nil {
		t.Fatal(err)
	}
	lsr := make(chan uint32, 1)
	go func() {
		for {
			pkts, _, e := sender.ReadRTCP()
			if e != nil {
				return
			}
			for _, p := range pkts {
				var reports []rtcp.ReceptionReport
				switch report := p.(type) {
				case *rtcp.ReceiverReport:
					reports = report.Reports
				case *rtcp.SenderReport:
					reports = report.Reports
				}
				for _, block := range reports {
					if block.LastSenderReport != 0 {
						select {
						case lsr <- block.LastSenderReport:
						default:
						}
					}
				}
			}
		}
	}()
	if code := postOffer(t, server.URL, id, "client", "s70e-client-nonce-0001", secret, client, true); code != 200 {
		t.Fatalf("client offer: %d", code)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && client.ConnectionState() != webrtc.PeerConnectionStateConnected {
		time.Sleep(10 * time.Millisecond)
	}
	if client.ConnectionState() != webrtc.PeerConnectionStateConnected {
		t.Fatalf("client leg did not connect: %s", client.ConnectionState())
	}

	payload := []byte{0xf8, 0xff, 0xfe} // one 20 ms Opus frame
	rtpSeq := uint16(100)
	write := func(frame uint32, padding bool) {
		t.Helper()
		packet := &rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: rtpSeq, Timestamp: 5000 + frame*960}, Payload: payload}
		if padding {
			packet.Header.Padding, packet.Header.PaddingSize, packet.Payload = true, 4, nil
		}
		if e := track.WriteRTP(packet); e != nil {
			t.Fatal(e)
		}
		rtpSeq++
		time.Sleep(20 * time.Millisecond)
	}
	lose := func() { rtpSeq++ } // a packet lost on the client->bridge leg
	for frame := uint32(0); frame <= 4; frame++ {
		write(frame, false)
	}
	lose() // frame 5
	write(6, false)
	write(7, false)
	lose() // frames 8, 9, 10
	lose()
	lose()
	write(11, false)
	write(12, false)
	write(12, true) // padding-only: a new RTP sequence on the last audio timestamp
	write(13, false)
	// Keep talking until a Receiver Report echoes the client's Sender Report.
	frame := uint32(14)
	var echoed uint32
	for deadline = time.Now().Add(8 * time.Second); echoed == 0 && time.Now().Before(deadline); frame++ {
		write(frame, false)
		select {
		case echoed = <-lsr:
		default:
		}
	}
	if echoed == 0 {
		t.Fatal("no Receiver Report with LSR reached the client: receiver RTCP is not drained")
	}

	at := func(frame uint32) uint64 { return uint64(frame) * 20000 }
	deadline = time.Now().Add(3 * time.Second)
	for {
		mu.Lock()
		_, last := seqAt[at(frame-1)]
		mu.Unlock()
		if last || time.Now().After(deadline) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	mu.Lock()
	defer mu.Unlock()
	for _, step := range []struct {
		from, to uint32
		advance  uint32
	}{{3, 4, 1}, {4, 6, 2}, {6, 7, 1}, {7, 11, 4}, {11, 12, 1}, {12, 13, 1}, {13, 14, 1}} {
		from, okFrom := seqAt[at(step.from)]
		to, okTo := seqAt[at(step.to)]
		if !okFrom || !okTo {
			t.Fatalf("frames %d/%d not both delivered: %v", step.from, step.to, seqAt)
		}
		if to-from != step.advance {
			t.Fatalf("bridge sequence %d->%d advanced by %d, want %d", step.from, step.to, to-from, step.advance)
		}
	}
	b.mu.Lock()
	r := b.rooms[id]
	b.mu.Unlock()
	r.mu.Lock()
	stats := r.transport
	r.mu.Unlock()
	if stats.UpSequenceMissing != 4 || stats.UpPaddingIgnored != 1 {
		t.Fatalf("upSequenceMissing=%d upPaddingIgnored=%d, want 4 and 1", stats.UpSequenceMissing, stats.UpPaddingIgnored)
	}
}
