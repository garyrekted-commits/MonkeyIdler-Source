using System.Diagnostics;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32;

namespace UsbCellularTether.Windows;

internal sealed class TunnelDiagnostics
{
    private const int PcProxyPort = 18080;
    private const int AndroidProxyPort = 28080;
    private readonly List<string> _lines = [];
    private readonly Action<string> _onLine;
    private readonly bool _tunnelRunning;
    private string? _serial;

    public TunnelDiagnostics(Action<string> onLine, bool tunnelRunning)
    {
        _onLine = onLine;
        _tunnelRunning = tunnelRunning;
    }

    public async Task<string> RunAsync(CancellationToken cancellationToken)
    {
        var path = Path.Combine(AppContext.BaseDirectory, $"diagnostics-{DateTime.Now:yyyyMMdd-HHmmss}.txt");
        Line($"USB Cellular Tether diagnostics {DateTime.Now:yyyy-MM-dd HH:mm:ss}");
        Line($"App: {GetAppVersion()}");
        Line($"Elevated: {IsElevated()}");
        Line($"Tunnel running at start: {_tunnelRunning}");
        Line("");

        await StepAsync("Desktop package files", CheckPackageFilesAsync, cancellationToken);
        await StepAsync("Windows proxy settings", CheckWindowsProxyAsync, cancellationToken);
        await StepAsync("ADB authorization", CheckAdbDevicesAsync, cancellationToken);
        await StepAsync("Android service", StartAndroidServiceAsync, cancellationToken);
        await StepAsync("ADB forward", EnsureAdbForwardAsync, cancellationToken);
        await StepAsync("Local proxy TCP", CheckLocalProxyTcpAsync, cancellationToken);
        await StepAsync("HTTP through phone", CheckHttpThroughPhoneProxyAsync, cancellationToken);
        await StepAsync("HTTPS through phone", CheckHttpsThroughPhoneProxyAsync, cancellationToken);
        await StepAsync("DNS through phone", CheckDohThroughPhoneProxyAsync, cancellationToken);
        await StepAsync("Windows DNS", CheckWindowsDnsAsync, cancellationToken);
        await StepAsync("Windows web request", CheckWindowsWebAsync, cancellationToken);
        await StepAsync("Tunnel processes", CheckTunnelProcessesAsync, cancellationToken);
        await StepAsync("Tunnel routes", CheckTunnelRoutesAsync, cancellationToken);
        await StepAsync("Tunnel DNS", CheckTunnelDnsAsync, cancellationToken);
        await StepAsync("Android recent logs", CaptureAndroidLogsAsync, cancellationToken);
        await StepAsync("Restore safety", CheckRestoreSafetyAsync, cancellationToken);

        await File.WriteAllLinesAsync(path, _lines, cancellationToken);
        Line("");
        Line($"Diagnostics saved: {path}");
        return path;
    }

    private async Task StepAsync(string name, Func<CancellationToken, Task<string>> action, CancellationToken cancellationToken)
    {
        var stopwatch = Stopwatch.StartNew();
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeSpan.FromSeconds(20));
            var detail = await action(timeout.Token);
            Line($"PASS {name} ({stopwatch.ElapsedMilliseconds} ms)");
            if (!string.IsNullOrWhiteSpace(detail))
            {
                Detail(detail);
            }
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            Line($"FAIL {name}: timed out after {stopwatch.ElapsedMilliseconds} ms");
        }
        catch (Exception ex)
        {
            Line($"FAIL {name}: {ex.Message}");
            ConnectionLog.WriteException("DIAG", ex);
        }
    }

    private Task<string> CheckPackageFilesAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var required = new[]
        {
            "UsbCellularTether.Windows.exe",
            "tun2socks.exe",
            "wintun.dll",
            Path.Combine("platform-tools", "adb.exe"),
        };

        var missing = required
            .Where(file => !File.Exists(Path.Combine(AppContext.BaseDirectory, file)))
            .ToArray();
        if (missing.Length > 0)
        {
            throw new FileNotFoundException("Missing: " + string.Join(", ", missing));
        }

        return Task.FromResult("All required companion files are present.");
    }

    private Task<string> CheckWindowsProxyAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        using var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Internet Settings");
        var enabled = key?.GetValue("ProxyEnable") is int value ? value : 0;
        var server = key?.GetValue("ProxyServer") as string ?? "(none)";
        return Task.FromResult($"ProxyEnable={enabled}; ProxyServer={server}");
    }

    private async Task<string> CheckAdbDevicesAsync(CancellationToken cancellationToken)
    {
        var result = await RunAdbAsync("devices -l", cancellationToken);
        var devices = AdbDeviceParser.ParseDevices(result.Stdout);
        var authorized = devices.FirstOrDefault(device => device.State == "device");
        if (authorized is null)
        {
            var unauthorized = devices.FirstOrDefault(device => device.State == "unauthorized");
            throw new InvalidOperationException(unauthorized is null
                ? "No authorized Android phone found."
                : "Phone is connected but USB debugging is not authorized.");
        }

        _serial = authorized.Serial;
        return Shorten(result.Stdout);
    }

    private async Task<string> StartAndroidServiceAsync(CancellationToken cancellationToken)
    {
        var serial = RequireSerial();
        var result = await RunAdbAsync($"-s {Quote(serial)} shell am start-foreground-service -n com.example.usbcellulartether/.TetherForegroundService", cancellationToken);
        if (result.ExitCode != 0)
        {
            throw new InvalidOperationException(result.Stderr.Trim());
        }

        return Shorten(result.Stdout);
    }

    private async Task<string> EnsureAdbForwardAsync(CancellationToken cancellationToken)
    {
        var serial = RequireSerial();
        if (!_tunnelRunning)
        {
            await RunAdbAsync($"-s {Quote(serial)} forward --remove tcp:{PcProxyPort}", cancellationToken);
            var create = await RunAdbAsync($"-s {Quote(serial)} forward tcp:{PcProxyPort} tcp:{AndroidProxyPort}", cancellationToken);
            if (create.ExitCode != 0)
            {
                throw new InvalidOperationException(create.Stderr.Trim());
            }
        }

        var list = await RunAdbAsync("forward --list", cancellationToken);
        if (!list.Stdout.Contains($"tcp:{PcProxyPort}", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException($"ADB forward tcp:{PcProxyPort} is missing.");
        }

        return Shorten(list.Stdout);
    }

    private static async Task<string> CheckLocalProxyTcpAsync(CancellationToken cancellationToken)
    {
        using var client = new TcpClient();
        await client.ConnectAsync(IPAddress.Loopback, PcProxyPort, cancellationToken);
        return $"Connected to 127.0.0.1:{PcProxyPort}.";
    }

    private static async Task<string> CheckHttpThroughPhoneProxyAsync(CancellationToken cancellationToken)
    {
        using var client = CreatePhoneProxyHttpClient();
        using var response = await client.GetAsync("http://example.com/", cancellationToken);
        var body = await response.Content.ReadAsByteArrayAsync(cancellationToken);
        return $"HTTP {(int)response.StatusCode}; {body.Length} bytes from example.com.";
    }

    private static async Task<string> CheckHttpsThroughPhoneProxyAsync(CancellationToken cancellationToken)
    {
        using var client = CreatePhoneProxyHttpClient();
        using var response = await client.GetAsync("https://www.cloudflare.com/cdn-cgi/trace", cancellationToken);
        var body = await response.Content.ReadAsStringAsync(cancellationToken);
        return $"HTTPS {(int)response.StatusCode}; {body.Length} chars; {FirstLine(body)}";
    }

    private static async Task<string> CheckDohThroughPhoneProxyAsync(CancellationToken cancellationToken)
    {
        using var client = CreatePhoneProxyHttpClient();
        using var request = new HttpRequestMessage(
            HttpMethod.Get,
            "https://cloudflare-dns.com/dns-query?name=example.com&type=A");
        request.Headers.TryAddWithoutValidation("accept", "application/dns-json");
        using var response = await client.SendAsync(request, cancellationToken);
        var body = await response.Content.ReadAsStringAsync(cancellationToken);
        if (!body.Contains("\"Answer\"", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException("DoH response did not contain an A record answer.");
        }

        return $"DoH {(int)response.StatusCode}; {Shorten(body)}";
    }

    private static async Task<string> CheckWindowsDnsAsync(CancellationToken cancellationToken)
    {
        var addresses = await Dns.GetHostAddressesAsync("example.com", AddressFamily.InterNetwork, cancellationToken);
        if (addresses.Length == 0)
        {
            throw new InvalidOperationException("No IPv4 addresses returned.");
        }

        return string.Join(", ", addresses.Select(address => address.ToString()));
    }

    private static async Task<string> CheckWindowsWebAsync(CancellationToken cancellationToken)
    {
        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(12) };
        using var response = await client.GetAsync("http://example.com/", cancellationToken);
        var body = await response.Content.ReadAsByteArrayAsync(cancellationToken);
        return $"HTTP {(int)response.StatusCode}; {body.Length} bytes through current Windows route.";
    }

    private static Task<string> CheckTunnelProcessesAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var processes = Process.GetProcesses()
            .Where(process => process.ProcessName.Contains("UsbCellularTether", StringComparison.OrdinalIgnoreCase) ||
                              process.ProcessName.Contains("tun2socks", StringComparison.OrdinalIgnoreCase) ||
                              process.ProcessName.Equals("adb", StringComparison.OrdinalIgnoreCase))
            .Select(process => $"{process.ProcessName}:{process.Id}")
            .ToArray();
        return Task.FromResult(processes.Length == 0 ? "No tether processes found." : string.Join(", ", processes));
    }

    private static async Task<string> CheckTunnelRoutesAsync(CancellationToken cancellationToken)
    {
        var route0 = await ProcessRunner.RunAsync("route.exe", "print 0.0.0.0", cancellationToken);
        var route128 = await ProcessRunner.RunAsync("route.exe", "print 128.0.0.0", cancellationToken);
        return Shorten(route0.Stdout + Environment.NewLine + route128.Stdout, 1800);
    }

    private static async Task<string> CheckTunnelDnsAsync(CancellationToken cancellationToken)
    {
        var result = await ProcessRunner.RunAsync("netsh.exe", "interface ipv4 show dnsservers", cancellationToken);
        return Shorten(result.Stdout, 1800);
    }

    private async Task<string> CaptureAndroidLogsAsync(CancellationToken cancellationToken)
    {
        if (_serial is null)
        {
            return "Skipped because no authorized phone was found.";
        }

        var result = await RunAdbAsync($"-s {Quote(_serial)} logcat -d -t 160", cancellationToken);
        var filtered = result.Stdout
            .Split(Environment.NewLine)
            .Where(line => line.Contains("usbcellulartether", StringComparison.OrdinalIgnoreCase) ||
                           line.Contains("AndroidRuntime", StringComparison.OrdinalIgnoreCase) ||
                           line.Contains("Tether", StringComparison.OrdinalIgnoreCase) ||
                           line.Contains("Proxy", StringComparison.OrdinalIgnoreCase))
            .TakeLast(80);
        var text = string.Join(Environment.NewLine, filtered);
        return string.IsNullOrWhiteSpace(text) ? "No recent app-specific Android logcat lines." : Shorten(text, 3000);
    }

    private async Task<string> CheckRestoreSafetyAsync(CancellationToken cancellationToken)
    {
        if (_tunnelRunning)
        {
            return "Skipped cleanup because the tunnel was running. Use Restore Internet after stopping if needed.";
        }

        await Tun2SocksEngine.RestoreNormalInternetAsync(cancellationToken);
        var result = await ProcessRunner.RunAsync("route.exe", "print 0.0.0.0", cancellationToken);
        return "Restore cleanup completed. " + Shorten(result.Stdout, 1200);
    }

    private async Task<ProcessResult> RunAdbAsync(string arguments, CancellationToken cancellationToken)
    {
        var adb = ResolveAdbPath();
        var result = await ProcessRunner.RunAsync(adb, arguments, cancellationToken);
        ConnectionLog.Write("DIAG", $"adb {arguments} exit={result.ExitCode}");
        return result;
    }

    private string RequireSerial() =>
        _serial ?? throw new InvalidOperationException("ADB authorization step did not find a phone.");

    private void Line(string line)
    {
        _lines.Add(line);
        if (!string.IsNullOrWhiteSpace(line))
        {
            _onLine(line);
        }
    }

    private void Detail(string text)
    {
        foreach (var line in text.Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries))
        {
            _lines.Add("  " + line);
        }
    }

    private static HttpClient CreatePhoneProxyHttpClient() =>
        new(new HttpClientHandler
        {
            Proxy = new WebProxy($"http://127.0.0.1:{PcProxyPort}"),
            UseProxy = true,
            ServerCertificateCustomValidationCallback = (_, _, _, _) => true,
        })
        {
            Timeout = TimeSpan.FromSeconds(12),
        };

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

        throw new FileNotFoundException("adb.exe was not found next to the companion app or in PATH.");
    }

    private static string GetAppVersion()
    {
        var version = typeof(TunnelDiagnostics).Assembly.GetName().Version;
        return version?.ToString() ?? "unknown";
    }

    private static bool IsElevated()
    {
        using var identity = WindowsIdentity.GetCurrent();
        return new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
    }

    private static string FirstLine(string value) =>
        value.Split('\n', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault()?.Trim() ?? "(empty)";

    private static string Shorten(string value, int maxLength = 700)
    {
        value = value.ReplaceLineEndings(Environment.NewLine).Trim();
        return value.Length <= maxLength ? value : value[..maxLength] + "...";
    }

    private static string Quote(string value) => "\"" + value.Replace("\"", "\\\"") + "\"";
}
