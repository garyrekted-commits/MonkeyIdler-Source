using System.Diagnostics;
using System.Net.Sockets;
namespace UsbCellularTether.Windows;

internal sealed class Tun2SocksEngine : IAsyncDisposable
{
    public const string InterfaceName = "wintun";
    private const string InterfaceAddress = "198.18.0.1";
    private const string InterfaceMask = "255.254.0.0";
    private const string ProxyEndpoint = "socks5://127.0.0.1:18100";
    private const string DnsProxyEndpoint = "http://127.0.0.1:18080";
    private static readonly string[] SplitDefaultRoutes = ["0.0.0.0/1", "128.0.0.0/1"];

    private Process? _process;
    private DnsProxyServer? _dnsProxy;
    private FullTunnelSocksServer? _socksServer;
    private bool _routesConfigured;

    public async Task StartAsync(
        Action<string> onLog,
        Action<TrafficStats> onTraffic,
        CancellationToken cancellationToken)
    {
        using var startLock = await TunnelPortGuard.AcquireStartLockAsync(cancellationToken);
        await DisposeAsync();
        await TunnelPortGuard.ReleaseStaleTunnelServicesAsync(cancellationToken);

        var executable = Path.Combine(AppContext.BaseDirectory, "tun2socks.exe");
        ConnectionLog.Write("TUN2SOCKS", $"Start requested. executable={executable}");
        onLog($"Starting tun2socks from {executable}");
        if (!File.Exists(executable))
        {
            throw new FileNotFoundException("Network Adapter Mode requires tun2socks.exe next to the companion executable.", executable);
        }

        WintunNative.EnsureAvailable();
        ConnectionLog.Write("TUN2SOCKS", "Wintun native DLL is available.");
        _socksServer = new FullTunnelSocksServer(onLog, onTraffic);
        await _socksServer.StartAsync(cancellationToken).ConfigureAwait(false);

        var startInfo = new ProcessStartInfo
        {
            FileName = executable,
            Arguments = $"--device {InterfaceName} --proxy {ProxyEndpoint} --tcp-auto-tuning --tcp-rcvbuf 4m --tcp-sndbuf 4m --loglevel error",
            RedirectStandardError = true,
            RedirectStandardOutput = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };

        _process = Process.Start(startInfo) ?? throw new InvalidOperationException("Failed to start tun2socks.");
        ConnectionLog.Write("TUN2SOCKS", $"Process started pid={_process.Id} args={startInfo.Arguments}");
        try
        {
            _process.PriorityClass = ProcessPriorityClass.AboveNormal;
        }
        catch
        {
            // Some systems do not allow changing priority; the tunnel can still run normally.
        }
        onLog($"tun2socks pid {_process.Id}");
        _ = Task.Run(() => DrainOutputAsync(_process.StandardOutput, cancellationToken), cancellationToken);
        _ = Task.Run(() => DrainOutputAsync(_process.StandardError, cancellationToken), cancellationToken);

        await WaitForInterfaceAsync(cancellationToken);
        await ConfigureInterfaceAsync(cancellationToken);
        if (_process.HasExited)
        {
            ConnectionLog.Write("TUN2SOCKS", $"Process exited early code={_process.ExitCode}");
            throw new InvalidOperationException($"tun2socks exited early with code {_process.ExitCode}.");
        }
        ConnectionLog.Write("TUN2SOCKS", "Routes configured on wintun interface.");
        _dnsProxy = new DnsProxyServer(
            InterfaceAddress,
            DnsProxyEndpoint,
            onLog,
            allowWindowsDnsFallback: false);
        try
        {
            _dnsProxy.Start();
        }
        catch (SocketException ex) when (ex.SocketErrorCode == SocketError.AddressAlreadyInUse)
        {
            ConnectionLog.Write("DNS", $"Bind {InterfaceAddress}:53 failed, retrying after cleanup: {ex.Message}");
            await TunnelPortGuard.ReleaseStaleTunnelServicesAsync(cancellationToken);
            _dnsProxy.Start();
        }

        ConnectionLog.Write("DNS", "Tunnel DNS proxy active on wintun address only.");
        onLog("Tunnel DNS proxy active on the virtual adapter.");
        _routesConfigured = true;
    }

    public async ValueTask DisposeAsync()
    {
        ConnectionLog.Write("TUN2SOCKS", "Dispose requested.");
        if (_process is not null && !_process.HasExited)
        {
            ConnectionLog.Write("TUN2SOCKS", $"Killing process pid={_process.Id}.");
            _process.Kill(entireProcessTree: true);
            await WaitWithTimeoutAsync(_process.WaitForExitAsync(), TimeSpan.FromSeconds(2));
        }

        _process?.Dispose();
        _process = null;

        if (_dnsProxy is not null)
        {
            await _dnsProxy.DisposeAsync();
            _dnsProxy = null;
        }

        if (_socksServer is not null)
        {
            await _socksServer.DisposeAsync();
            _socksServer = null;
        }

        if (_routesConfigured)
        {
            await RestoreNormalInternetAsync(CancellationToken.None);
            _routesConfigured = false;
        }
    }

    public static async Task RestoreNormalInternetAsync(CancellationToken cancellationToken)
    {
        ConnectionLog.Write("RESTORE", "Restoring normal Windows internet state.");
        await WifiAdapterGuard.RestoreSavedAdaptersAsync(cancellationToken);
        foreach (var process in Process.GetProcessesByName("tun2socks"))
        {
            try
            {
                ConnectionLog.Write("RESTORE", $"Killing stale tun2socks pid={process.Id}.");
                process.Kill(entireProcessTree: true);
                await WaitWithTimeoutAsync(process.WaitForExitAsync(cancellationToken), TimeSpan.FromSeconds(2));
            }
            catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception or OperationCanceledException)
            {
                ConnectionLog.Write("RESTORE", $"Could not kill tun2socks pid={process.Id}: {ex.Message}");
            }
            finally
            {
                process.Dispose();
            }
        }

        await RemoveRoutesAsync(cancellationToken);
        await RemovePersistentRoutesAsync(cancellationToken);
        await ProcessRunner.RunAsync(
            "netsh.exe",
            $"interface ipv4 set dnsservers name=\"{InterfaceName}\" source=dhcp",
            cancellationToken);
        ConnectionLog.Write("RESTORE", "Normal internet cleanup finished.");
    }

    private static async Task ConfigureInterfaceAsync(CancellationToken cancellationToken)
    {
        ConnectionLog.Write("NETSH", "Configuring wintun interface.");
        await RunNetshCheckedAsync(
            $"interface ipv4 set address name=\"{InterfaceName}\" source=static addr={InterfaceAddress} mask={InterfaceMask}",
            cancellationToken);
        await RunNetshCheckedAsync(
            $"interface ipv4 set subinterface \"{InterfaceName}\" mtu=1420 store=active",
            cancellationToken,
            allowNonZero: true);
        await RemoveRoutesAsync(cancellationToken);
        await RemovePersistentRoutesAsync(cancellationToken);
        foreach (var route in SplitDefaultRoutes)
        {
            await RunNetshCheckedAsync(
                $"interface ipv4 add route {route} \"{InterfaceName}\" {InterfaceAddress} metric=1 store=active",
                cancellationToken,
                allowNonZero: true);
        }

        await RunNetshCheckedAsync(
            $"interface ipv4 set dnsservers name=\"{InterfaceName}\" static address={InterfaceAddress} register=none validate=no",
            cancellationToken,
            allowNonZero: true);
        ConnectionLog.Write("NETSH", "Interface routes and DNS configured.");
    }

    private static async Task RemoveRoutesAsync(CancellationToken cancellationToken)
    {
        await ProcessRunner.RunAsync("netsh.exe", $"interface ipv4 delete route 0.0.0.0/0 \"{InterfaceName}\" {InterfaceAddress}", cancellationToken);
        foreach (var route in SplitDefaultRoutes)
        {
            await ProcessRunner.RunAsync("netsh.exe", $"interface ipv4 delete route {route} \"{InterfaceName}\" {InterfaceAddress}", cancellationToken);
        }
    }

    private static async Task RemovePersistentRoutesAsync(CancellationToken cancellationToken)
    {
        foreach (var route in SplitDefaultRoutes)
        {
            // Older builds accidentally created persistent routes on every start.
            // Deleting several times clears duplicate entries left by those builds.
            for (var attempt = 0; attempt < 20; attempt++)
            {
                var netshResult = await ProcessRunner.RunAsync(
                    "netsh.exe",
                    $"interface ipv4 delete route {route} \"{InterfaceName}\" {InterfaceAddress} store=persistent",
                    cancellationToken);
                var routeResult = await ProcessRunner.RunAsync(
                    "route.exe",
                    $"-p delete {route[..^2]} mask 128.0.0.0 {InterfaceAddress}",
                    cancellationToken);
                if (netshResult.ExitCode != 0 && routeResult.ExitCode != 0)
                {
                    break;
                }
            }
        }
    }

    private static async Task WaitForInterfaceAsync(CancellationToken cancellationToken)
    {
        var deadline = DateTimeOffset.UtcNow.AddSeconds(10);
        while (DateTimeOffset.UtcNow < deadline)
        {
            var result = await ProcessRunner.RunAsync("netsh.exe", "interface show interface", cancellationToken);
            if (result.Stdout.Contains(InterfaceName, StringComparison.OrdinalIgnoreCase))
            {
                return;
            }

            await Task.Delay(500, cancellationToken);
        }

        throw new InvalidOperationException("tun2socks started, but the Wintun network interface did not appear.");
    }

    private static async Task RunNetshCheckedAsync(
        string arguments,
        CancellationToken cancellationToken,
        bool allowNonZero = false)
    {
        var result = await ProcessRunner.RunAsync("netsh.exe", arguments, cancellationToken);
        if (result.ExitCode != 0 && !allowNonZero)
        {
            ConnectionLog.Write("NETSH", $"FAILED args=\"{arguments}\" stdout=\"{result.Stdout}\" stderr=\"{result.Stderr}\"");
            throw new InvalidOperationException($"netsh failed: {result.Stdout} {result.Stderr}".Trim());
        }
        ConnectionLog.Write("NETSH", $"exit={result.ExitCode} args=\"{arguments}\"");
    }

    private static async Task DrainOutputAsync(
        StreamReader reader,
        CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            var line = await reader.ReadLineAsync(cancellationToken);
            if (line is null) return;
        }
    }

    private static async Task WaitWithTimeoutAsync(Task task, TimeSpan timeout)
    {
        await Task.WhenAny(task, Task.Delay(timeout));
    }
}
