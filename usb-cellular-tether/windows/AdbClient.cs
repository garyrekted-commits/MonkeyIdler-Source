using System.Diagnostics;

namespace UsbCellularTether.Windows;

internal sealed class AdbClient
{
    private readonly string _adbPath;

    public AdbClient(string? adbPath = null)
    {
        _adbPath = adbPath ?? ResolveAdbPath();
    }

    public async Task<IReadOnlyList<AdbDevice>> GetDevicesAsync(CancellationToken cancellationToken)
    {
        var result = await RunAsync("devices", cancellationToken);
        var devices = AdbDeviceParser.ParseDevices(result.Stdout);
        ConnectionLog.Write("ADB", devices.Count == 0
            ? "devices: none"
            : "devices: " + string.Join(", ", devices.Select(device => $"{device.Serial}:{device.State}")));
        return devices;
    }

    public Task ForwardAsync(string serial, int pcPort, int phonePort, CancellationToken cancellationToken) =>
        RunCheckedAsync(
            $"-s {Quote(serial)} forward tcp:{pcPort} tcp:{phonePort}",
            cancellationToken,
            "Unable to create ADB tunnel.");

    public Task RemoveForwardAsync(string serial, int pcPort, CancellationToken cancellationToken) =>
        RunAsync($"-s {Quote(serial)} forward --remove tcp:{pcPort}", cancellationToken);

    public Task StartAndroidTetherServiceAsync(string serial, CancellationToken cancellationToken) =>
        RunCheckedAsync(
            $"-s {Quote(serial)} shell am start-foreground-service -n com.example.usbcellulartether/.TetherForegroundService",
            cancellationToken,
            "Unable to start the Android tether service.");

    private async Task RunCheckedAsync(string arguments, CancellationToken cancellationToken, string errorMessage)
    {
        var result = await RunAsync(arguments, cancellationToken);
        if (result.ExitCode != 0)
        {
            throw new InvalidOperationException($"{errorMessage} {result.Stderr}".Trim());
        }
    }

    private async Task<ProcessResult> RunAsync(string arguments, CancellationToken cancellationToken)
    {
        ConnectionLog.Write("ADB", $"adb {arguments}");
        var startInfo = new ProcessStartInfo
        {
            FileName = _adbPath,
            Arguments = arguments,
            RedirectStandardError = true,
            RedirectStandardOutput = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };

        using var process = Process.Start(startInfo) ?? throw new InvalidOperationException("Failed to start adb.");
        var stdoutTask = process.StandardOutput.ReadToEndAsync(cancellationToken);
        var stderrTask = process.StandardError.ReadToEndAsync(cancellationToken);

        await process.WaitForExitAsync(cancellationToken);
        var result = new ProcessResult(process.ExitCode, await stdoutTask, await stderrTask);
        var stdout = Shorten(result.Stdout);
        var stderr = Shorten(result.Stderr);
        ConnectionLog.Write("ADB", $"exit={result.ExitCode} stdout=\"{stdout}\" stderr=\"{stderr}\"");
        return result;
    }

    private static string Shorten(string value)
    {
        value = value.ReplaceLineEndings(" | ").Trim();
        return value.Length <= 500 ? value : value[..500] + "...";
    }

    private static string ResolveAdbPath()
    {
        var localPlatformTools = Path.Combine(AppContext.BaseDirectory, "platform-tools", "adb.exe");
        if (File.Exists(localPlatformTools)) return localPlatformTools;

        var pathValue = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
        foreach (var directory in pathValue.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            var candidate = Path.Combine(directory.Trim(), "adb.exe");
            if (File.Exists(candidate)) return candidate;
        }

        throw new FileNotFoundException("adb.exe was not found. Install Android platform-tools or place adb.exe in a platform-tools folder next to this app.");
    }

    private static string Quote(string value) => "\"" + value.Replace("\"", "\\\"") + "\"";

    private sealed record ProcessResult(int ExitCode, string Stdout, string Stderr);
}

internal sealed record AdbDevice(string Serial, string State);
