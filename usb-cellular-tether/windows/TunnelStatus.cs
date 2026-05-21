namespace UsbCellularTether.Windows;

internal sealed record TunnelStatus(
    string State,
    string Message,
    string? DeviceSerial = null,
    bool ProxyEnabled = false,
    bool TunnelActive = false,
    TrafficStats? Traffic = null,
    ConnectionHealth Health = ConnectionHealth.Idle)
{
    public static TunnelStatus Idle { get; } = new(
        "Ready",
        "Connect USB, start tether on the phone, then press Start.",
        Health: ConnectionHealth.Idle);
}
