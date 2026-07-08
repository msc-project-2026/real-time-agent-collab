// Package system reports host capacity so the deploy path can refuse gracefully
// when the box is full instead of degrading every other app on it. All readings
// come from Linux sources (/proc, statfs) since the CLI only runs on the target
// VPS.
package system

import (
	"bufio"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

// Resources is a point-in-time capacity snapshot.
type Resources struct {
	MemTotalMB  uint64  `json:"mem_total_mb"`
	MemAvailMB  uint64  `json:"mem_available_mb"`
	MemUsedPct  float64 `json:"mem_used_pct"`
	DiskTotalMB uint64  `json:"disk_total_mb"`
	DiskAvailMB uint64  `json:"disk_available_mb"`
	DiskUsedPct float64 `json:"disk_used_pct"`
	LoadPerCPU  float64 `json:"load_per_cpu"`
	CPUCount    int     `json:"cpu_count"`
}

// Thresholds beyond which a new deploy should be refused.
type Thresholds struct {
	MaxMemPct  float64
	MaxDiskPct float64
}

// DefaultThresholds are conservative caps; the agent surfaces a "needs more
// space" prompt when either is exceeded.
var DefaultThresholds = Thresholds{MaxMemPct: 90, MaxDiskPct: 90}

// Read gathers a resource snapshot. diskPath selects the filesystem to measure
// (e.g. the apps directory).
func Read(diskPath string) (*Resources, error) {
	r := &Resources{CPUCount: numCPU()}

	memTotal, memAvail, err := readMem()
	if err != nil {
		return nil, err
	}
	r.MemTotalMB = memTotal / 1024
	r.MemAvailMB = memAvail / 1024
	if memTotal > 0 {
		r.MemUsedPct = round2(float64(memTotal-memAvail) / float64(memTotal) * 100)
	}

	var st unix.Statfs_t
	if err := unix.Statfs(diskPath, &st); err != nil {
		return nil, fmt.Errorf("statfs %s: %w", diskPath, err)
	}
	total := st.Blocks * uint64(st.Bsize) / (1024 * 1024)
	avail := st.Bavail * uint64(st.Bsize) / (1024 * 1024)
	r.DiskTotalMB = total
	r.DiskAvailMB = avail
	if total > 0 {
		r.DiskUsedPct = round2(float64(total-avail) / float64(total) * 100)
	}

	if load, err := readLoad1(); err == nil && r.CPUCount > 0 {
		r.LoadPerCPU = round2(load / float64(r.CPUCount))
	}
	return r, nil
}

// ExceedsThresholds reports whether the snapshot is over capacity, with a
// human-readable reason for the agent to relay.
func (r *Resources) ExceedsThresholds(t Thresholds) (bool, string) {
	if r.MemUsedPct >= t.MaxMemPct {
		return true, fmt.Sprintf("memory at %.0f%% (limit %.0f%%)", r.MemUsedPct, t.MaxMemPct)
	}
	if r.DiskUsedPct >= t.MaxDiskPct {
		return true, fmt.Sprintf("disk at %.0f%% (limit %.0f%%)", r.DiskUsedPct, t.MaxDiskPct)
	}
	return false, ""
}

func readMem() (totalKB, availKB uint64, err error) {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0, 0, fmt.Errorf("read meminfo: %w", err)
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) < 2 {
			continue
		}
		val, _ := strconv.ParseUint(fields[1], 10, 64)
		switch fields[0] {
		case "MemTotal:":
			totalKB = val
		case "MemAvailable:":
			availKB = val
		}
	}
	return totalKB, availKB, sc.Err()
}

func readLoad1() (float64, error) {
	data, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return 0, err
	}
	fields := strings.Fields(string(data))
	if len(fields) == 0 {
		return 0, fmt.Errorf("empty loadavg")
	}
	return strconv.ParseFloat(fields[0], 64)
}

func numCPU() int {
	data, err := os.ReadFile("/proc/cpuinfo")
	if err != nil {
		return 1
	}
	n := strings.Count(string(data), "processor\t")
	if n == 0 {
		return 1
	}
	return n
}

// FreePort asks the kernel for an unused TCP port by binding :0. Useful for the
// rare non-HTTP service that cannot sit behind the reverse proxy.
func FreePort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

func round2(f float64) float64 {
	return float64(int(f*100+0.5)) / 100
}
