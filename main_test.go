package main

import (
	"strings"
	"testing"
)

func TestNextSlot(t *testing.T) {
	nows := []int64{0, 1, 124, 125, 126, 1_700_000_000_123, 1_700_000_000_199}
	for _, now := range nows {
		at := nextSlot(now)
		if at <= now {
			t.Fatalf("now=%d: scheduled in the past (%d)", now, at)
		}
		if at-now < leadMs {
			t.Fatalf("now=%d: not enough lead time (%d)", now, at-now)
		}
		if at-now > leadMs+stepMs {
			t.Fatalf("now=%d: scheduled too far out (%d)", now, at-now)
		}
		if at%stepMs != 0 {
			t.Fatalf("now=%d: not quantized to grid (%d)", now, at)
		}
	}
}

func TestCleanName(t *testing.T) {
	if got := cleanName("   "); got != "guest" {
		t.Fatalf("blank name: %q", got)
	}
	if got := cleanName("  kate  "); got != "kate" {
		t.Fatalf("trim: %q", got)
	}
	long := strings.Repeat("x", 40)
	if got := cleanName(long); len([]rune(got)) != 16 {
		t.Fatalf("length cap: %q", got)
	}
	if got := cleanName("a\x00b"); strings.ContainsRune(got, '\x00') {
		t.Fatalf("control chars: %q", got)
	}
}
