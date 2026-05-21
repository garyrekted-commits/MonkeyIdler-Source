using System.Net.Sockets;

namespace UsbCellularTether.Windows;

internal sealed class TunnelSession : ITetherSession
{
    private readonly AdbClient _adb;
    private readonly WindowsProxySettings _proxySettings;
    private readonly int _pcPort;
    private readonly int _phonePort;
    private readonly Action<TunnelStatus> _onStatus;
    private string? _activeSerial;
    private bool _proxyEnabled;

    public TunnelSession(
        AdbClient adb,
        WindowsProxySettings proxySettings,
        int pcPort,
        int phonePort,
        Action<TunnelStatus>? onStatus = null)
    {
        _adb = adb;
        _proxySettings = proxySettings;
        _pcPort = pcPort;
        _phonePort = phonePort;
        _onStatus = onStatus ?? (_ => { });
    }

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                var device = await WaitForAuthorizedDeviceAsync(cancellationToken);
                await _adb.StartAndroidTetherServiceAsync(device.Serial, cancellationToken);
                if (_activeSerial != device.Serial)
                {
                    await ActivateTunnelAsync(device.Serial, cancellationToken);
                }

                await VerifyProxyAsync(cancellationToken);
                Publish("Connected", $"Connected through {device.Serial}.", device.Serial, proxyEnabled: true, tunnelActive: true);
                await MonitorConnectionAsync(device.Serial, cancellationToken);
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception ex)
            {
                Publish("Disconnected", ex.Message);
                await CleanupTunnelAsync(CancellationToken.None);
                await Task.Delay(TimeSpan.FromSeconds(2), cancellationToken);
            }
        }
    }

    public async ValueTask DisposeAsync()
    {
        await CleanupTunnelAsync(CancellationToken.None);
    }

    private async Task<AdbDevice> WaitForAuthorizedDeviceAsync(CancellationToken cancellationToken)
    {
        while (true)
        {
            var devices = await _adb.GetDevicesAsync(cancellationToken);
            var authorized = devices.FirstOrDefault(device => device.State == "device");
            if (authorized is not null) return authorized;

            var unauthorized = devices.FirstOrDefault(device => device.State == "unauthorized");
            if (unauthorized is not null)
            {
                Publish(
                    "Authorize USB Debugging",
                    "Phone found, but USB debugging is not authorized. Accept the prompt on the phone.",
                    unauthorized.Serial);
            }
            else
            {
                Publish("Waiting For Phone", "Waiting for Android phone over USB...");
            }

            await Task.Delay(TimeSpan.FromSeconds(2), cancellationToken);
        }
    }

    private async Task ActivateTunnelAsync(string serial, CancellationToken cancellationToken)
    {
        await CleanupTunnelAsync(cancellationToken);
        await _adb.ForwardAsync(serial, _pcPort, _phonePort, cancellationToken);
        _activeSerial = serial;
        _proxySettings.EnableLocalProxy(_pcPort);
        _proxyEnabled = true;
        Publish(
            "Tunnel Active",
            $"ADB tunnel active: PC 127.0.0.1:{_pcPort} -> phone 127.0.0.1:{_phonePort}",
            serial,
            proxyEnabled: true,
            tunnelActive: true);
    }

    private async Task VerifyProxyAsync(CancellationToken cancellationToken)
    {
        try
        {
            using var client = new TcpClient();
            await client.ConnectAsync("127.0.0.1", _pcPort, cancellationToken);
        }
        catch (SocketException ex)
        {
            throw new InvalidOperationException("The ADB tunnel is up, but the Android proxy is not reachable. Start tethering in the Android app.", ex);
        }
    }

    private async Task MonitorConnectionAsync(string serial, CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            var devices = await _adb.GetDevicesAsync(cancellationToken);
            if (!devices.Any(device => device.Serial == serial && device.State == "device"))
            {
                throw new InvalidOperationException("Phone disconnected or USB debugging authorization was lost.");
            }

            await VerifyProxyAsync(cancellationToken);
            await Task.Delay(TimeSpan.FromSeconds(5), cancellationToken);
        }
    }

    private async Task CleanupTunnelAsync(CancellationToken cancellationToken)
    {
        if (_proxyEnabled)
        {
            _proxySettings.Restore();
            _proxyEnabled = false;
            Publish("Proxy Restored", "Windows system proxy restored.");
        }

        if (_activeSerial is not null)
        {
            try
            {
                await _adb.RemoveForwardAsync(_activeSerial, _pcPort, cancellationToken);
            }
            catch
            {
                // Best effort cleanup; a disconnected phone may already have removed the forward.
            }

            _activeSerial = null;
        }
    }

    private void Publish(
        string state,
        string message,
        string? deviceSerial = null,
        bool? proxyEnabled = null,
        bool? tunnelActive = null)
    {
        _onStatus(
            new TunnelStatus(
                state,
                message,
                deviceSerial ?? _activeSerial,
                proxyEnabled ?? _proxyEnabled,
                tunnelActive ?? (_activeSerial is not null)));
    }
}
