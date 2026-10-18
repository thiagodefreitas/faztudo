package config

import (
	"bufio"
	"os"
	"strconv"
	"strings"
)

const (
	gib           = int64(1) << 30
	autoMemoryMin = 2 * gib
	autoMemoryMax = 8 * gib
)

// MemoryAuto asks for a limit derived from the machine's total memory.
const MemoryAuto = "auto"

// MemInfoFile is read for total and available memory. Tests replace it.
var MemInfoFile = "/proc/meminfo"

// MemInfo returns MemTotal and MemAvailable in bytes; zero when unknown.
func MemInfo() (total, available int64) {
	f, err := os.Open(MemInfoFile)
	if err != nil {
		return 0, 0
	}
	defer f.Close()
	s := bufio.NewScanner(f)
	for s.Scan() {
		fields := strings.Fields(s.Text())
		if len(fields) < 2 {
			continue
		}
		kb, err := strconv.ParseInt(fields[1], 10, 64)
		if err != nil {
			continue
		}
		switch fields[0] {
		case "MemTotal:":
			total = kb * 1024
		case "MemAvailable:":
			available = kb * 1024
		}
	}
	return total, available
}

// AutoMemoryBytes is a quarter of total RAM, clamped to 2G..8G. An unknown
// total gives 4G.
func AutoMemoryBytes(total int64) int64 {
	if total <= 0 {
		return 4 * gib
	}
	return min(max(total/4, autoMemoryMin), autoMemoryMax)
}

// ResolveMemoryMax turns "auto" into a size such as "7G"; other values pass
// through unchanged.
func ResolveMemoryMax(value string) string {
	if value != MemoryAuto {
		return value
	}
	total, _ := MemInfo()
	return strconv.FormatInt(AutoMemoryBytes(total)/gib, 10) + "G"
}

// MemoryBytes parses a size such as 4G (units are powers of 1024); false
// when it is not a size.
func MemoryBytes(value string) (int64, bool) {
	if !memoryLimitPattern.MatchString(value) {
		return 0, false
	}
	mult := int64(1)
	switch value[len(value)-1] {
	case 'K':
		mult = 1 << 10
	case 'M':
		mult = 1 << 20
	case 'G':
		mult = gib
	case 'T':
		mult = gib << 10
	}
	n, err := strconv.ParseInt(strings.TrimRight(value, "KMGT"), 10, 64)
	if err != nil {
		return 0, false
	}
	return n * mult, true
}
