using System.Net.Sockets;

namespace UsbCellularTether.Windows;

internal sealed class AdapterTunnelSession : ITetherSession
{
    private const int PcProxyPort = 18080;
    private const int AndroidProxyPort = 28080;
    private static readonly TimeSpan ProxyStartupTimeout = TimeSpan.FromSeconds(30);

    private readonly AdbClient _adb;
    private readonly Action<TunnelStatus> _onStatus;
    private readonly bool _disableWifiWhenActive;
    private readonly Tun2SocksEngine _tun2Socks = new();
    private WifiAdapterGuard? _wifiGuard;
    private string? _activeSerial;
    private CancellationTokenSource? _linkedCancellation;
    private TrafficStats _traffic = TrafficStats.Empty;

    public AdapterTunnelSession(AdbClient adb, Action<TunnelStatus>? onStatus = null, bool disableWifiWhenActive = false)
    {
        _adb = adb;
        _onStatus = onStatus ?? (_ => { });
        _disableWifiWhenActive = disableWifiWhenActive;
    }

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        ConnectionLog.Write("SESSION", "RunAsync starting.");
        _linkedCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        var token = _linkedCancellation.Token;

        var device = await WaitForAuthorizedDeviceAsync(token);
        _activeSerial = device.Serial;
        ConnectionLog.Write("SESSION", $"Authorized device selected: {device.Serial}");
        Publish("Adapter Starting", $"Preparing network adapter for {device.Serial}.", device.Serial);

        await EnsurePhoneProxyAsync(device.Serial, ProxyStartupTimeout, token);

        await _tun2Socks.StartAsync(
            message => Publish("Adapter Engine", message, device.Serial, tunnelActive: true),
            stats =>
            {
                _traffic = stats;
                Publish("Full Internet Active", "Traffic flowing through Android cellular proxy.", device.Serial, tunnelActive: true);
            },
            token);
        Publish("Full Internet Active", "Adapter is active and forwarding traffic through the Android proxy.", device.Serial, tunnelActive: true);

        if (_disableWifiWhenActive)
        {
            _wifiGuard = new WifiAdapterGuard();
            await _wifiGuard.DisableActiveWifiAdaptersAsync(token);
            Publish(
                "Full Internet Active",
                "Tunnel active. Wi-Fi adapters were disabled so traffic stays on cellular USB.",
                device.Serial,
                tunnelActive: true);
        }

        await MonitorConnectionAsync(device.Serial, token);
    }

    public async ValueTask DisposeAsync()
    {
        ConnectionLog.Write("SESSION", "DisposeAsync requested.");
        _linkedCancellation?.Cancel();
        _linkedCancellation?.Dispose();
        _linkedCancellation = null;

        await _tun2Socks.DisposeAsync();

        if (_wifiGuard is not null)
        {
            await _wifiGuard.DisposeAsync();
            _wifiGuard = null;
        }

        if (_activeSerial is not null)
        {
            try
            {
                ConnectionLog.Write("SESSION", $"Removing ADB forward tcp:{PcProxyPort} for {_activeSerial}.");
                await _adb.RemoveForwardAsync(_activeSerial, PcProxyPort, CancellationToken.None);
            }
            catch (Exception ex)
            {
                ConnectionLog.WriteException("SESSION", ex);
                // A disconnected phone may already have removed the forward.
            }

            _activeSerial = null;
        }

        Publish("Idle", "Full Internet Mode stopped.");
    }

    private async Task<AdbDevice> WaitForAuthorizedDeviceAsync(CancellationToken cancellationToken)
    {
        while (true)
        {
            var devices = await _adb.GetDevicesAsync(cancellationToken);
            var authorized = devices.FirstOrDefault(device => device.State == "device");
            if (authorized is not null) return authorized;

            var unauthorized = devices.FirstOrDefault(device => device.State == "unauthorized");
            Publish(
                unauthorized is null ? "Waiting For Phone" : "Authorize USB Debugging",
                unauthorized is null
                    ? "Waiting for Android phone over USB..."
                    : "Phone found, but USB debugging is not authorized. Unlock the phone and tap Allow on the USB debugging prompt.",
                unauthorized?.Serial);

            await Task.Delay(TimeSpan.FromSeconds(2), cancellationToken);
        }
    }

    private static async Task VerifyAndroidProxyAsync(CancellationToken cancellationToken)
    {
        try
        {
            ConnectionLog.Write("PROXY", $"Checking 127.0.0.1:{PcProxyPort}.");
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeSpan.FromSeconds(5));
            using var tcpClient = new TcpClient();
            await tcpClient.ConnectAsync("127.0.0.1", PcProxyPort, timeout.Token);
            ConnectionLog.Write("PROXY", "Check succeeded.");
        }
        catch (Exception ex) when (ex is SocketException or OperationCanceledException)
        {
            ConnectionLog.WriteException("PROXY", ex);
            throw new InvalidOperationException("The Android proxy is not reachable. Start tethering in the Android app first.", ex);
        }
    }

    private async Task EnsurePhoneProxyAsync(string serial, TimeSpan timeout, CancellationToken cancellationToken)
    {
        var deadline = DateTimeOffset.UtcNow.Add(timeout);
        Exception? lastError = null;

        while (DateTimeOffset.UtcNow < deadline && !cancellationToken.IsCancellationRequested)
        {
            try
            {
                ConnectionLog.Write("STARTUP", $"Starting Android service on {serial}.");
                await _adb.StartAndroidTetherServiceAsync(serial, cancellationToken);
                Publish("Phone Service Started", "Android tether service started over USB.", serial);

                try
                {
                    ConnectionLog.Write("STARTUP", $"Removing stale ADB forward tcp:{PcProxyPort}.");
                    await _adb.RemoveForwardAsync(serial, PcProxyPort, cancellationToken);
                }
                catch (Exception ex)
                {
                    ConnectionLog.Write("STARTUP", $"No stale forward removed: {ex.Message}");
                    // It is fine if no previous forward exists.
                }

                ConnectionLog.Write("STARTUP", $"Creating ADB forward tcp:{PcProxyPort} -> tcp:{AndroidProxyPort}.");
                await _adb.ForwardAsync(serial, PcProxyPort, AndroidProxyPort, cancellationToken);
                await VerifyAndroidProxyAsync(cancellationToken);
                ConnectionLog.Write("STARTUP", "Phone proxy is ready.");
                Publish("Phone Proxy Ready", "Android cellular proxy is reachable over USB.", serial, tunnelActive: true);
                return;
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception ex)
            {
                lastError = ex;
                ConnectionLog.WriteException("STARTUP", ex);
                Publish("Starting Phone Proxy", $"Waiting for Android proxy to come online. {ex.Message}", serial);
                await Task.Delay(TimeSpan.FromSeconds(2), cancellationToken);
            }
        }

        throw new InvalidOperationException("The Android proxy did not become ready in time.", lastError);
    }

    private async Task MonitorConnectionAsync(string serial, CancellationToken cancellationToken)
    {
        var failures = 0;
        var heartbeat = 0;
        const int failuresBeforeRecovery = 2;

        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                heartbeat++;
                var devices = await _adb.GetDevicesAsync(cancellationToken);
                var active = devices.FirstOrDefault(device => device.Serial == serial && device.State == "device")
                    ?? devices.FirstOrDefault(device => device.State == "device");
                if (active is null)
                {
                    failures++;
                    ConnectionLog.Write("MONITOR", $"Heartbeat {heartbeat}: no authorized device. failures={failures}");
                    var unauthorized = devices.FirstOrDefault(device => device.State == "unauthorized");
                    Publish(
                        unauthorized is null ? "Waiting For Phone" : "Authorize USB Debugging",
                        unauthorized is null
                            ? "Phone/ADB connection dropped. Keep USB plugged in; reconnecting automatically."
                            : "Phone is connected but not authorized. Unlock it and tap Allow on the USB debugging prompt.",
                        unauthorized?.Serial ?? serial,
                        tunnelActive: true);
                    await Task.Delay(TimeSpan.FromSeconds(3), cancellationToken);
                    continue;
                }

                if (!string.Equals(_activeSerial, active.Serial, StringComparison.Ordinal))
                {
                    _activeSerial = active.Serial;
                    serial = active.Serial;
                    ConnectionLog.Write("MONITOR", $"Device serial changed/reconnected as {serial}.");
                    Publish("Phone Reconnected", $"Phone reconnected as {serial}. Restoring proxy.", serial, tunnelActive: true);
                }

                await VerifyAndroidProxyAsync(cancellationToken);
                ConnectionLog.Write("MONITOR", $"Heartbeat {heartbeat}: ok serial={active.Serial} failures={failures}");
                failures = 0;
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception ex)
            {
                failures++;
                ConnectionLog.WriteException("MONITOR", ex);
                if (failures < failuresBeforeRecovery)
                {
                    ConnectionLog.Write("MONITOR", $"Transient proxy check failed ({failures}/{failuresBeforeRecovery}); keeping active tunnel.");
                    Publish("Recovering", $"Temporary proxy check failed; keeping tunnel up. {ex.Message}", serial, tunnelActive: true);
                }
                else
                {
                    Publish("Recovering", $"Connection hiccup detected; restarting phone proxy. {ex.Message}", serial, tunnelActive: true);
                    try
                    {
                        await EnsurePhoneProxyAsync(serial, TimeSpan.FromSeconds(12), cancellationToken);
                        failures = 0;
                    }
                    catch (OperationCanceledException)
                    {
                        throw;
                    }
                    catch (Exception restartEx)
                    {
                        ConnectionLog.WriteException("MONITOR", restartEx);
                        Publish("Recovering", $"Phone proxy restart did not finish yet. Will keep trying. {restartEx.Message}", serial, tunnelActive: true);
                    }
                }
            }

            await Task.Delay(failures == 0 ? TimeSpan.FromSeconds(15) : TimeSpan.FromSeconds(5), cancellationToken);
        }
    }

    private void Publish(string state, string message, string? deviceSerial = null, bool tunnelActive = false)
    {
        _onStatus(new TunnelStatus(
            state,
            message,
            deviceSerial ?? _activeSerial,
            ProxyEnabled: false,
            tunnelActive,
            _traffic,
            MapHealth(state)));
    }

    private static ConnectionHealth MapHealth(string state)
    {
        if (state.Contains("Error", StringComparison.OrdinalIgnoreCase))
        {
            return ConnectionHealth.Error;
        }

        if (state.Contains("Recovering", StringComparison.OrdinalIgnoreCase) ||
            state.Contains("Waiting", StringComparison.OrdinalIgnoreCase) ||
            state.Contains("Starting", StringComparison.OrdinalIgnoreCase) ||
            state.Contains("Authorize", StringComparison.OrdinalIgnoreCase))
        {
            return ConnectionHealth.Recovering;
        }

        if (state.Contains("Active", StringComparison.OrdinalIgnoreCase) ||
            state.Contains("Ready", StringComparison.OrdinalIgnoreCase))
        {
            return ConnectionHealth.Healthy;
        }

        return ConnectionHealth.Degraded;
    }
}
