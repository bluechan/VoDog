package main

import "testing"

// S105o: a replaced client leg's base must stay on the previous leg's frame grid.
func TestAlignedLegGapKeepsFrameGrid(t *testing.T) {
	cases := []struct {
		gapUS   uint64
		frameMS uint16
		want    uint64
	}{
		{0, 20, 20_000},              // never shorter than one frame
		{7_300, 20, 20_000},          // sub-frame gap rounds up to one frame
		{15_007_300, 20, 15_000_000}, // 15 s path switch: nearest whole frame
		{15_013_000, 20, 15_020_000}, // rounds to nearest, not down
		{30_000, 10, 30_000},         // 10 ms frames keep their own grid
		{123_456, 0, 123_456},        // unknown frame duration: unchanged
	}
	for _, c := range cases {
		if got := alignedLegGap(c.gapUS, c.frameMS); got != c.want {
			t.Errorf("alignedLegGap(%d, %d) = %d, want %d", c.gapUS, c.frameMS, got, c.want)
		}
		if c.frameMS != 0 {
			if got := alignedLegGap(c.gapUS, c.frameMS); got%(uint64(c.frameMS)*1000) != 0 {
				t.Errorf("alignedLegGap(%d, %d) = %d is off the %d ms grid", c.gapUS, c.frameMS, got, c.frameMS)
			}
		}
	}
}
