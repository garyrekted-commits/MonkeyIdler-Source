using System.Runtime.InteropServices;

namespace UsbCellularTether.Windows;

internal sealed class AdapterPacketBridge
{
    private readonly WindowsVirtualAdapter _adapter;
    private readonly PacketFramedStream _framedStream;
    private readonly Action<TunnelStatus> _onStatus;

    public AdapterPacketBridge(
        WindowsVirtualAdapter adapter,
        PacketFramedStream framedStream,
        Action<TunnelStatus> onStatus)
    {
        _adapter = adapter;
        _framedStream = framedStream;
        _onStatus = onStatus;
    }

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        await Task.WhenAll(
            Task.Run(() => AdapterToAndroidLoop(cancellationToken), cancellationToken),
            Task.Run(() => AndroidToAdapterLoop(cancellationToken), cancellationToken));
    }

    private async Task AdapterToAndroidLoop(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            var packetPointer = WintunNative.WintunReceivePacket(_adapter.Session, out var packetSize);
            if (packetPointer == IntPtr.Zero)
            {
                await Task.Delay(5, cancellationToken);
                continue;
            }

            try
            {
                var packet = new byte[packetSize];
                Marshal.Copy(packetPointer, packet, 0, packet.Length);
                await _framedStream.SendAsync(packet, cancellationToken);
                _onStatus(new TunnelStatus("Adapter Traffic", $"Sent {packet.Length} byte packet to Android.", ProxyEnabled: false, TunnelActive: true));
            }
            finally
            {
                WintunNative.WintunReleaseReceivePacket(_adapter.Session, packetPointer);
            }
        }
    }

    private async Task AndroidToAdapterLoop(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            var packet = await _framedStream.ReceiveAsync(cancellationToken);
            if (packet is null) return;

            var sendPointer = WintunNative.WintunAllocateSendPacket(_adapter.Session, (uint)packet.Length);
            if (sendPointer == IntPtr.Zero)
            {
                throw new InvalidOperationException("Failed to allocate a Wintun send packet.");
            }

            Marshal.Copy(packet, 0, sendPointer, packet.Length);
            WintunNative.WintunSendPacket(_adapter.Session, sendPointer);
            _onStatus(new TunnelStatus("Adapter Traffic", $"Received {packet.Length} byte packet from Android.", ProxyEnabled: false, TunnelActive: true));
        }
    }
}
