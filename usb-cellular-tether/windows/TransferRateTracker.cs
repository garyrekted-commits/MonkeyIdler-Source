namespace UsbCellularTether.Windows;

internal sealed class TransferRateTracker
{
    private long _lastTotalBytes;
    private long _lastSampleTicks;

    public void Reset()
    {
        _lastTotalBytes = 0;
        _lastSampleTicks = 0;
    }

    public double Update(TrafficStats stats)
    {
        var total = stats.Total;
        var now = Environment.TickCount64;
        if (_lastSampleTicks == 0)
        {
            _lastSampleTicks = now;
            _lastTotalBytes = total;
            return 0;
        }

        var elapsedSeconds = (now - _lastSampleTicks) / 1000.0;
        if (elapsedSeconds < 0.25)
        {
            return 0;
        }

        var delta = Math.Max(0, total - _lastTotalBytes);
        var rate = delta / elapsedSeconds;
        _lastSampleTicks = now;
        _lastTotalBytes = total;
        return rate;
    }

    public static string FormatRate(double bytesPerSecond)
    {
        if (bytesPerSecond < 1024) return $"{bytesPerSecond:F0} B/s";
        var kib = bytesPerSecond / 1024.0;
        if (kib < 1024) return $"{kib:F1} KiB/s";
        return $"{kib / 1024.0:F1} MiB/s";
    }
}
