using System.Net.NetworkInformation;

namespace UsbCellularTether.Windows;

internal sealed class WindowsVirtualAdapter : IAsyncDisposable
{
    public const string AdapterName = "USB Cellular Tether";
    public const string AdapterAddress = "10.77.0.1";
    public const string AndroidAddress = "10.77.0.2";
    public const string Netmask = "255.255.255.252";

    private IntPtr _adapter;
    private IntPtr _session;
    private bool _configured;

    public IntPtr Session => _session;
    public bool IsOpen => _adapter != IntPtr.Zero && _session != IntPtr.Zero;

    public async Task OpenAsync(CancellationToken cancellationToken)
    {
        WintunNative.EnsureAvailable();
        if (IsOpen) return;

        _adapter = WintunNative.WintunCreateAdapter(AdapterName, "UsbCellularTether", WintunNative.AdapterGuid);
        if (_adapter == IntPtr.Zero)
        {
            throw new InvalidOperationException("Failed to create or open the Wintun network adapter.");
        }

        _session = WintunNative.WintunStartSession(_adapter, WintunNative.PacketCapacity);
        if (_session == IntPtr.Zero)
        {
            throw new InvalidOperationException("Failed to start the Wintun packet session.");
        }

        await ConfigureAddressAsync(cancellationToken);
        _configured = true;
    }

    public async Task AddDefaultRouteAsync(CancellationToken cancellationToken)
    {
        var interfaceIndex = GetInterfaceIndex();
        await RunNetshCheckedAsync(
            $"interface ipv4 add route 0.0.0.0/0 \"{AdapterName}\" {AndroidAddress} metric=5",
            cancellationToken,
            allowAlreadyExists: true);
        await ProcessRunner.RunAsync("route.exe", $"add 0.0.0.0 mask 0.0.0.0 {AndroidAddress} metric 5 if {interfaceIndex}", cancellationToken);
    }

    public async Task RemoveDefaultRouteAsync(CancellationToken cancellationToken)
    {
        await ProcessRunner.RunAsync("route.exe", $"delete 0.0.0.0 mask 0.0.0.0 {AndroidAddress}", cancellationToken);
        await ProcessRunner.RunAsync("netsh.exe", $"interface ipv4 delete route 0.0.0.0/0 \"{AdapterName}\" {AndroidAddress}", cancellationToken);
    }

    public async ValueTask DisposeAsync()
    {
        if (_configured)
        {
            try
            {
                await RemoveDefaultRouteAsync(CancellationToken.None);
            }
            catch
            {
                // Best effort cleanup. Windows may already have removed routes when the adapter closed.
            }
            _configured = false;
        }

        if (_session != IntPtr.Zero)
        {
            WintunNative.WintunEndSession(_session);
            _session = IntPtr.Zero;
        }

        if (_adapter != IntPtr.Zero)
        {
            WintunNative.WintunCloseAdapter(_adapter);
            _adapter = IntPtr.Zero;
        }
    }

    private async Task ConfigureAddressAsync(CancellationToken cancellationToken)
    {
        await RunNetshCheckedAsync(
            $"interface ipv4 set address name=\"{AdapterName}\" static {AdapterAddress} {Netmask}",
            cancellationToken);
        await RunNetshCheckedAsync(
            $"interface ipv4 set dns name=\"{AdapterName}\" static 1.1.1.1",
            cancellationToken,
            allowAlreadyExists: true);
    }

    private static async Task RunNetshCheckedAsync(
        string arguments,
        CancellationToken cancellationToken,
        bool allowAlreadyExists = false)
    {
        var result = await ProcessRunner.RunAsync("netsh.exe", arguments, cancellationToken);
        if (result.ExitCode != 0 &&
            !(allowAlreadyExists && (result.Stdout.Contains("already", StringComparison.OrdinalIgnoreCase) ||
                                     result.Stderr.Contains("already", StringComparison.OrdinalIgnoreCase))))
        {
            throw new InvalidOperationException($"netsh failed: {result.Stdout} {result.Stderr}".Trim());
        }
    }

    private static int GetInterfaceIndex()
    {
        var adapter = NetworkInterface.GetAllNetworkInterfaces()
            .FirstOrDefault(networkInterface =>
                networkInterface.Name.Equals(AdapterName, StringComparison.OrdinalIgnoreCase) ||
                networkInterface.Description.Contains(AdapterName, StringComparison.OrdinalIgnoreCase));

        return adapter?.GetIPProperties().GetIPv4Properties()?.Index
            ?? throw new InvalidOperationException("Wintun adapter was created, but Windows has not exposed an interface index yet.");
    }
}
