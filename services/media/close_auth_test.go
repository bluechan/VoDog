package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"
)

func signedCloseRequest(secret, callID, nonce string, timestamp int64) *http.Request {
	path := "/close/" + callID
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(fmt.Sprintf("POST\n%s\n%d\n%s\n", path, timestamp, nonce)))
	r := httptest.NewRequest("POST", path, nil)
	r.Header.Set("X-CC-Timestamp", strconv.FormatInt(timestamp, 10))
	r.Header.Set("X-CC-Nonce", nonce)
	r.Header.Set("X-CC-Signature", base64.RawURLEncoding.EncodeToString(mac.Sum(nil)))
	r.Header.Set("X-Media-Epoch", "1")
	return r
}

func TestCloseAcceptsSignedRequestsAndRejectsForgeriesAndReplays(t *testing.T) {
	secret := "media-secret-at-least-thirty-two-bytes!"
	b := &bridge{rooms: map[string]*room{}, secret: secret}
	callID := "11111111-1111-4111-8111-111111111111"
	now := time.Now().Unix()
	status := func(r *http.Request) int {
		w := httptest.NewRecorder()
		b.closeHandler(w, r)
		return w.Code
	}

	if got := status(signedCloseRequest(secret, callID, "nonce-aaaaaaaaaaaaaaaaaaaa", now)); got != 204 {
		t.Fatalf("signed close: got %d, want 204", got)
	}
	if got := status(signedCloseRequest(secret, callID, "nonce-aaaaaaaaaaaaaaaaaaaa", now)); got != 401 {
		t.Fatalf("replayed nonce: got %d, want 401", got)
	}
	if got := status(signedCloseRequest("wrong-secret-at-least-thirty-two-bytes", callID, "nonce-bbbbbbbbbbbbbbbbbbbb", now)); got != 401 {
		t.Fatalf("wrong key: got %d, want 401", got)
	}
	if got := status(signedCloseRequest(secret, callID, "nonce-cccccccccccccccccccc", now-120)); got != 401 {
		t.Fatalf("stale timestamp: got %d, want 401", got)
	}
	// A signature for one call does not close another.
	other := signedCloseRequest(secret, callID, "nonce-dddddddddddddddddddd", now)
	other.URL.Path = "/close/22222222-2222-4222-8222-222222222222"
	if got := status(other); got != 401 {
		t.Fatalf("signature moved to another call: got %d, want 401", got)
	}
	unsigned := httptest.NewRequest("POST", "/close/"+callID, nil)
	unsigned.Header.Set("X-Media-Epoch", "1")
	if got := status(unsigned); got != 401 {
		t.Fatalf("unsigned close: got %d, want 401", got)
	}
	// Transition: a not-yet-updated Control still closes with the bearer form.
	legacy := httptest.NewRequest("POST", "/close/"+callID, nil)
	legacy.Header.Set("Authorization", "Bearer "+secret)
	legacy.Header.Set("X-Media-Epoch", "1")
	if got := status(legacy); got != 204 {
		t.Fatalf("legacy bearer close: got %d, want 204", got)
	}
	if got := status(httptest.NewRequest("GET", "/close/"+callID, nil)); got != 401 {
		t.Fatalf("GET close: got %d, want 401", got)
	}
}
