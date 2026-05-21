using System.Buffers.Binary;
using System.Net.Sockets;

namespace UsbCellularTether.Windows;

internal sealed class PacketFramedStream : IAsyncDisposable
{
    private const int MaxPacketSize = 64 * 1024;
    private readonly TcpClient _client;
    private readonly NetworkStream _stream;

    public PacketFramedStream(TcpClient client)
    {
        _client = client;
        _stream = client.GetStream();
    }

    public async Task SendAsync(ReadOnlyMemory<byte> packet, CancellationToken cancellationToken)
    {
        if (packet.Length is <= 0 or > MaxPacketSize)
        {
            throw new InvalidOperationException($"Invalid packet size: {packet.Length}");
        }

        var header = new byte[4];
        BinaryPrimitives.WriteInt32BigEndian(header, packet.Length);
        await _stream.WriteAsync(header, cancellationToken);
        await _stream.WriteAsync(packet, cancellationToken);
    }

    public async Task<byte[]?> ReceiveAsync(CancellationToken cancellationToken)
    {
        var header = new byte[4];
        if (!await ReadExactAsync(header, cancellationToken)) return null;
        var length = BinaryPrimitives.ReadInt32BigEndian(header);
        if (length is <= 0 or > MaxPacketSize)
        {
            throw new InvalidOperationException($"Invalid packet size from Android: {length}");
        }

        var packet = new byte[length];
        return await ReadExactAsync(packet, cancellationToken) ? packet : null;
    }

    public async ValueTask DisposeAsync()
    {
        await _stream.DisposeAsync();
        _client.Dispose();
    }

    private async Task<bool> ReadExactAsync(Memory<byte> buffer, CancellationToken cancellationToken)
    {
        var total = 0;
        while (total < buffer.Length)
        {
            var read = await _stream.ReadAsync(buffer[total..], cancellationToken);
            if (read == 0) return false;
            total += read;
        }
        return true;
    }
}
