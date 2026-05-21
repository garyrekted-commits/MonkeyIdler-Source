namespace UsbCellularTether.Windows;

internal static class AdbDeviceParser
{
    public static IReadOnlyList<AdbDevice> ParseDevices(string adbDevicesOutput) =>
        adbDevicesOutput
            .Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Skip(1)
            .Select(ParseDeviceLine)
            .Where(device => device is not null)
            .Cast<AdbDevice>()
            .ToList();

    private static AdbDevice? ParseDeviceLine(string line)
    {
        var parts = line.Split('\t', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        return parts.Length < 2 ? null : new AdbDevice(parts[0], parts[1]);
    }
}
