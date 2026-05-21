namespace UsbCellularTether.Windows;

internal sealed record TrafficStats(long BytesOut, long BytesIn)
{
    public long Total => BytesOut + BytesIn;

    public static TrafficStats Empty { get; } = new(0, 0);
}
