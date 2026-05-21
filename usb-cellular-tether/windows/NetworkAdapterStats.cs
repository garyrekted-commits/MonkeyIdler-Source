using System.Net.NetworkInformation;

namespace UsbCellularTether.Windows;

internal sealed record NetworkAdapterStats(
    string Name,
    string Description,
    int InterfaceIndex,
    OperationalStatus OperationalStatus,
    long SpeedBitsPerSecond,
    long BytesSent,
    long BytesReceived,
    long UnicastPacketsSent,
    long UnicastPacketsReceived,
    long NonUnicastPacketsSent,
    long NonUnicastPacketsReceived,
    long OutgoingPacketsDiscarded,
    long IncomingPacketsDiscarded,
    long OutgoingPacketsWithErrors,
    long IncomingPacketsWithErrors,
    long Ipv4BytesSent,
    long Ipv4BytesReceived,
    long Ipv6BytesSent,
    long Ipv6BytesReceived)
{
    public long TotalBytes => BytesSent + BytesReceived;
    public long TotalPackets =>
        UnicastPacketsSent + UnicastPacketsReceived +
        NonUnicastPacketsSent + NonUnicastPacketsReceived;

    public static NetworkAdapterStats Empty { get; } = new(
        "(none)",
        "(adapter not found)",
        -1,
        OperationalStatus.NotPresent,
        0,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);

    public string ToSummaryLine() =>
        $"Adapter {Name} ({Description}) idx={InterfaceIndex} status={OperationalStatus} " +
        $"link={FormatSpeed(SpeedBitsPerSecond)} | " +
        $"out={FormatBytes(BytesSent)} in={FormatBytes(BytesReceived)} total={FormatBytes(TotalBytes)} | " +
        $"pkts out={UnicastPacketsSent + NonUnicastPacketsSent} in={UnicastPacketsReceived + NonUnicastPacketsReceived} | " +
        $"discard out={OutgoingPacketsDiscarded} in={IncomingPacketsDiscarded} | " +
        $"errors out={OutgoingPacketsWithErrors} in={IncomingPacketsWithErrors} | " +
        $"IPv4 out={FormatBytes(Ipv4BytesSent)} in={FormatBytes(Ipv4BytesReceived)} | " +
        $"IPv6 out={FormatBytes(Ipv6BytesSent)} in={FormatBytes(Ipv6BytesReceived)}";

    public string ToDisplayBlock(TrafficStats? tunnelTraffic)
    {
        var tunnel = tunnelTraffic ?? TrafficStats.Empty;
        return string.Join(Environment.NewLine,
        [
            $"Tunnel (SOCKS path): out {FormatBytes(tunnel.BytesOut)} | in {FormatBytes(tunnel.BytesIn)} | total {FormatBytes(tunnel.Total)}",
            $"Adapter: {Name} — {Description}",
            $"State: {OperationalStatus} | Index: {InterfaceIndex} | Link: {FormatSpeed(SpeedBitsPerSecond)}",
            $"Bytes — outgoing: {FormatBytes(BytesSent)} | incoming: {FormatBytes(BytesReceived)} | total: {FormatBytes(TotalBytes)}",
            $"Packets — outgoing: {UnicastPacketsSent + NonUnicastPacketsSent:N0} | incoming: {UnicastPacketsReceived + NonUnicastPacketsReceived:N0}",
            $"Unicast — sent: {UnicastPacketsSent:N0} | received: {UnicastPacketsReceived:N0}",
            $"Non-unicast — sent: {NonUnicastPacketsSent:N0} | received: {NonUnicastPacketsReceived:N0}",
            $"Discards — outgoing: {OutgoingPacketsDiscarded:N0} | incoming: {IncomingPacketsDiscarded:N0}",
            $"Errors — outgoing: {OutgoingPacketsWithErrors:N0} | incoming: {IncomingPacketsWithErrors:N0}",
            $"IPv4 — out: {FormatBytes(Ipv4BytesSent)} | in: {FormatBytes(Ipv4BytesReceived)}",
            $"IPv6 — out: {FormatBytes(Ipv6BytesSent)} | in: {FormatBytes(Ipv6BytesReceived)}",
        ]);
    }

    private static string FormatBytes(long bytes)
    {
        if (bytes < 1024) return $"{bytes} B";
        var kib = bytes / 1024.0;
        if (kib < 1024) return $"{kib:F1} KiB";
        var mib = kib / 1024.0;
        if (mib < 1024) return $"{mib:F1} MiB";
        return $"{mib / 1024.0:F1} GiB";
    }

    private static string FormatSpeed(long bitsPerSecond)
    {
        if (bitsPerSecond <= 0) return "unknown";
        if (bitsPerSecond >= 1_000_000_000) return $"{bitsPerSecond / 1_000_000_000.0:F1} Gbps";
        if (bitsPerSecond >= 1_000_000) return $"{bitsPerSecond / 1_000_000.0:F1} Mbps";
        if (bitsPerSecond >= 1_000) return $"{bitsPerSecond / 1_000.0:F1} Kbps";
        return $"{bitsPerSecond} bps";
    }
}
