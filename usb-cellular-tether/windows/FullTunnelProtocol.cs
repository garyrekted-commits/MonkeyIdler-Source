using System.Buffers.Binary;
using System.Text;

namespace UsbCellularTether.Windows;

internal enum FullTunnelMessageType : byte
{
    OpenTcp = 1,
    TcpData = 2,
    CloseTcp = 3,
    UdpData = 4,
    Error = 5,
}

internal static class FullTunnelProtocol
{
    public static async Task WriteOpenTcpAsync(Stream stream, int sessionId, string host, int port, CancellationToken cancellationToken)
    {
        var hostBytes = Encoding.UTF8.GetBytes(host);
        using var payload = new MemoryStream();
        payload.WriteByte((byte)FullTunnelMessageType.OpenTcp);
        WriteInt(payload, sessionId);
        WriteShort(payload, hostBytes.Length);
        payload.Write(hostBytes);
        WriteShort(payload, port);
        await WriteFrameAsync(stream, payload.ToArray(), cancellationToken);
    }

    public static Task WriteTcpDataAsync(Stream stream, int sessionId, ReadOnlyMemory<byte> data, CancellationToken cancellationToken) =>
        WriteSessionDataFastAsync(stream, FullTunnelMessageType.TcpData, sessionId, data, cancellationToken);

    public static Task WriteCloseTcpAsync(Stream stream, int sessionId, CancellationToken cancellationToken) =>
        WriteSessionDataFastAsync(stream, FullTunnelMessageType.CloseTcp, sessionId, ReadOnlyMemory<byte>.Empty, cancellationToken);

    public static async Task WriteUdpDataAsync(Stream stream, string host, int port, ReadOnlyMemory<byte> data, CancellationToken cancellationToken)
    {
        var hostBytes = Encoding.UTF8.GetBytes(host);
        using var payload = new MemoryStream();
        payload.WriteByte((byte)FullTunnelMessageType.UdpData);
        WriteShort(payload, hostBytes.Length);
        payload.Write(hostBytes);
        WriteShort(payload, port);
        WriteInt(payload, data.Length);
        payload.Write(data.Span);
        await WriteFrameAsync(stream, payload.ToArray(), cancellationToken);
    }

    public static async Task<FullTunnelMessage?> ReadAsync(Stream stream, CancellationToken cancellationToken)
    {
        var header = new byte[4];
        if (!await ReadExactAsync(stream, header, cancellationToken)) return null;
        var length = BinaryPrimitives.ReadInt32BigEndian(header);
        if (length <= 0 || length > 1024 * 1024) throw new InvalidOperationException($"Invalid tunnel frame length: {length}");
        var payload = new byte[length];
        if (!await ReadExactAsync(stream, payload, cancellationToken)) return null;

        var offset = 0;
        var type = (FullTunnelMessageType)payload[offset++];
        return type switch
        {
            FullTunnelMessageType.OpenTcp => throw new InvalidOperationException("Windows should not receive OpenTcp."),
            FullTunnelMessageType.TcpData => ReadSessionMessage(type, payload, ref offset),
            FullTunnelMessageType.CloseTcp => ReadSessionMessage(type, payload, ref offset),
            FullTunnelMessageType.UdpData => ReadUdpMessage(payload, ref offset),
            FullTunnelMessageType.Error => ReadSessionMessage(type, payload, ref offset),
            _ => throw new InvalidOperationException($"Unknown tunnel message type: {type}"),
        };
    }

    private static FullTunnelMessage ReadSessionMessage(FullTunnelMessageType type, byte[] payload, ref int offset)
    {
        var sessionId = ReadInt(payload, ref offset);
        var data = payload[offset..];
        return new FullTunnelMessage(type, sessionId, null, 0, data);
    }

    private static FullTunnelMessage ReadUdpMessage(byte[] payload, ref int offset)
    {
        var hostLength = ReadShort(payload, ref offset);
        var host = Encoding.UTF8.GetString(payload, offset, hostLength);
        offset += hostLength;
        var port = ReadShort(payload, ref offset);
        var dataLength = ReadInt(payload, ref offset);
        var data = payload.AsSpan(offset, dataLength).ToArray();
        return new FullTunnelMessage(FullTunnelMessageType.UdpData, 0, host, port, data);
    }

    private static async Task WriteSessionDataFastAsync(Stream stream, FullTunnelMessageType type, int sessionId, ReadOnlyMemory<byte> data, CancellationToken cancellationToken)
    {
        var header = new byte[9];
        BinaryPrimitives.WriteInt32BigEndian(header.AsSpan(0, 4), 1 + 4 + data.Length);
        header[4] = (byte)type;
        BinaryPrimitives.WriteInt32BigEndian(header.AsSpan(5, 4), sessionId);
        await stream.WriteAsync(header, cancellationToken);
        if (!data.IsEmpty)
        {
            await stream.WriteAsync(data, cancellationToken);
        }
    }

    private static async Task WriteFrameAsync(Stream stream, byte[] payload, CancellationToken cancellationToken)
    {
        var header = new byte[4];
        BinaryPrimitives.WriteInt32BigEndian(header, payload.Length);
        await stream.WriteAsync(header, cancellationToken);
        await stream.WriteAsync(payload, cancellationToken);
        await stream.FlushAsync(cancellationToken);
    }

    private static async Task<bool> ReadExactAsync(Stream stream, Memory<byte> buffer, CancellationToken cancellationToken)
    {
        var readTotal = 0;
        while (readTotal < buffer.Length)
        {
            var read = await stream.ReadAsync(buffer[readTotal..], cancellationToken);
            if (read == 0) return false;
            readTotal += read;
        }
        return true;
    }

    private static void WriteInt(Stream stream, int value)
    {
        Span<byte> bytes = stackalloc byte[4];
        BinaryPrimitives.WriteInt32BigEndian(bytes, value);
        stream.Write(bytes);
    }

    private static void WriteShort(Stream stream, int value)
    {
        Span<byte> bytes = stackalloc byte[2];
        BinaryPrimitives.WriteUInt16BigEndian(bytes, (ushort)value);
        stream.Write(bytes);
    }

    private static int ReadInt(byte[] bytes, ref int offset)
    {
        var value = BinaryPrimitives.ReadInt32BigEndian(bytes.AsSpan(offset, 4));
        offset += 4;
        return value;
    }

    private static int ReadShort(byte[] bytes, ref int offset)
    {
        var value = BinaryPrimitives.ReadUInt16BigEndian(bytes.AsSpan(offset, 2));
        offset += 2;
        return value;
    }
}

internal sealed record FullTunnelMessage(
    FullTunnelMessageType Type,
    int SessionId,
    string? Host,
    int Port,
    byte[] Data);
