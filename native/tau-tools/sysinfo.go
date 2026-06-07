package main

import (
	"errors"
	"flag"
	"runtime"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/host"
	"github.com/shirou/gopsutil/v4/load"
	"github.com/shirou/gopsutil/v4/mem"
	"github.com/shirou/gopsutil/v4/process"
)

type sysinfo struct {
	Platform  string         `json:"platform"`
	Runtime   runtimeInfo    `json:"runtime"`
	Host      hostSummary    `json:"host"`
	CPU       []cpuSummary   `json:"cpu,omitempty"`
	CPUUsage  []float64      `json:"cpuUsagePercent,omitempty"`
	Memory    *memorySummary `json:"memory,omitempty"`
	Swap      *swapSummary   `json:"swap,omitempty"`
	Load      *loadSummary   `json:"load,omitempty"`
	Disk      []diskSummary  `json:"disk,omitempty"`
	Processes processSummary `json:"processes"`
}

type runtimeInfo struct {
	GOOS         string `json:"goos"`
	GOARCH       string `json:"goarch"`
	NumCPU       int    `json:"numCPU"`
	NumGoroutine int    `json:"numGoroutine"`
}

type hostSummary struct {
	Uptime          uint64 `json:"uptime"`
	Procs           uint64 `json:"procs"`
	OS              string `json:"os"`
	Platform        string `json:"platform"`
	PlatformFamily  string `json:"platformFamily"`
	PlatformVersion string `json:"platformVersion"`
	KernelArch      string `json:"kernelArch"`
}

type cpuSummary struct {
	VendorID  string  `json:"vendorId"`
	Cores     int32   `json:"cores"`
	ModelName string  `json:"modelName"`
	MHz       float64 `json:"mhz"`
}

type diskSummary struct {
	Mountpoint string   `json:"mountpoint"`
	Fstype     string   `json:"fstype"`
	Opts       []string `json:"opts,omitempty"`
	Total      uint64   `json:"total,omitempty"`
	Free       uint64   `json:"free,omitempty"`
	Used       uint64   `json:"used,omitempty"`
	UsedPct    float64  `json:"usedPercent,omitempty"`
}

type memorySummary struct {
	Total       uint64  `json:"total"`
	Available   uint64  `json:"available"`
	Used        uint64  `json:"used"`
	UsedPercent float64 `json:"usedPercent"`
}

type swapSummary struct {
	Total       uint64  `json:"total"`
	Used        uint64  `json:"used"`
	Free        uint64  `json:"free"`
	UsedPercent float64 `json:"usedPercent"`
}

type loadSummary struct {
	Load1  float64 `json:"load1"`
	Load5  float64 `json:"load5"`
	Load15 float64 `json:"load15"`
}

type processSummary struct {
	Count int32 `json:"count"`
}

func runSysinfo(args []string) error {
	fs := newFlagSet("sysinfo")
	pretty := fs.Bool("pretty", false, "Pretty-print JSON")

	if err := parseFlags(fs, args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}

	hostInfo, _ := host.Info()
	cpuInfo, _ := cpu.Info()
	cpuPercent, _ := cpu.Percent(0, true)
	memInfo, _ := mem.VirtualMemory()
	swapInfo, _ := mem.SwapMemory()
	loadInfo, _ := load.Avg()
	disks, _ := disk.Partitions(false)
	processCount, _ := process.Pids()

	cpus := make([]cpuSummary, 0, len(cpuInfo))
	for _, c := range cpuInfo {
		cpus = append(cpus, cpuSummary{
			VendorID:  c.VendorID,
			Cores:     c.Cores,
			ModelName: c.ModelName,
			MHz:       c.Mhz,
		})
	}

	diskSummaries := make([]diskSummary, 0, len(disks))
	for _, d := range disks {
		summary := diskSummary{
			Mountpoint: d.Mountpoint,
			Fstype:     d.Fstype,
			Opts:       d.Opts,
		}
		if usage, err := disk.Usage(d.Mountpoint); err == nil && usage != nil {
			summary.Total = usage.Total
			summary.Free = usage.Free
			summary.Used = usage.Used
			summary.UsedPct = usage.UsedPercent
		}
		diskSummaries = append(diskSummaries, summary)
	}

	hostOut := hostSummary{}
	if hostInfo != nil {
		hostOut = hostSummary{
			Uptime:          hostInfo.Uptime,
			Procs:           hostInfo.Procs,
			OS:              hostInfo.OS,
			Platform:        hostInfo.Platform,
			PlatformFamily:  hostInfo.PlatformFamily,
			PlatformVersion: hostInfo.PlatformVersion,
			KernelArch:      hostInfo.KernelArch,
		}
	}

	var memoryOut *memorySummary
	if memInfo != nil {
		memoryOut = &memorySummary{
			Total:       memInfo.Total,
			Available:   memInfo.Available,
			Used:        memInfo.Used,
			UsedPercent: memInfo.UsedPercent,
		}
	}

	var swapOut *swapSummary
	if swapInfo != nil {
		swapOut = &swapSummary{
			Total:       swapInfo.Total,
			Used:        swapInfo.Used,
			Free:        swapInfo.Free,
			UsedPercent: swapInfo.UsedPercent,
		}
	}

	var loadOut *loadSummary
	if loadInfo != nil {
		loadOut = &loadSummary{
			Load1:  loadInfo.Load1,
			Load5:  loadInfo.Load5,
			Load15: loadInfo.Load15,
		}
	}

	info := sysinfo{
		Platform: runtime.GOOS + "/" + runtime.GOARCH,
		Runtime: runtimeInfo{
			GOOS:         runtime.GOOS,
			GOARCH:       runtime.GOARCH,
			NumCPU:       runtime.NumCPU(),
			NumGoroutine: runtime.NumGoroutine(),
		},
		Host:     hostOut,
		CPU:      cpus,
		CPUUsage: cpuPercent,
		Memory:   memoryOut,
		Swap:     swapOut,
		Load:     loadOut,
		Disk:     diskSummaries,
		Processes: processSummary{
			Count: int32(len(processCount)),
		},
	}

	return writeJSON(info, *pretty)
}
