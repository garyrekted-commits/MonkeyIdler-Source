using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;

namespace UsbCellularTether.Windows;

internal sealed class FullTunnelSocksServer : IAsyncDisposable
{
    public const int SocksPort = 18100;
    public const int RelayPort = 18182;
    private const int AndroidHttpProxyPort = 18080;

    private readonly Action<string> _onLog;
    private readonly Action<TrafficStats> _onTraffic;
    private TcpListener? _tcpListener;
    private CancellationTokenSource? _cancellation;
    private Task? _tcpTask;
    private long _bytesOut;
    private long _bytesIn;
    private long _lastTrafficPublishTicks;

    public FullTunnelSocksServer(Action<string> onLog, Action<TrafficStats> onTraffic)
    {
        _onLog = onLog;
        _onTraffic = onTraffic;
    }

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        _cancellation = new CancellationTokenSource();
        SocketException? lastError = null;
        for (var attempt = 0; attempt < 8; attempt++)
        {
            try
            {
                _tcpListener = new TcpListener(IPAddress.Loopback, SocksPort);
                _tcpListener.Server.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
                _tcpListener.Start();
                _tcpTask = Task.Run(() => AcceptTcpAsync(_cancellation.Token));
                _onLog($"Optimized SOCKS5 listening on 127.0.0.1:{SocksPort}; UDP is disabled so browsers use fast TCP instead of QUIC.");
                return;
            }
            catch (SocketException ex) when (ex.SocketErrorCode == SocketError.AddressAlreadyInUse && attempt < 7)
            {
                lastError = ex;
                _tcpListener = null;
                await TunnelPortGuard.ReleaseStaleTunnelServicesAsync(cancellationToken).ConfigureAwait(false);
                await Task.Delay(300, cancellationToken).ConfigureAwait(false);
            }
        }

        throw new InvalidOperationException(
            $"SOCKS port {SocksPort} is still in use. Close other Cellular USB Link windows and run the latest Apply script.",
            lastError);
    }

    public async ValueTask DisposeAsync()
    {
        _cancellation?.Cancel();
        if (_tcpListener is not null)
        {
            try
            {
                _tcpListener.Server.LingerState = new LingerOption(true, 0);
            }
            catch
            {
                // Best effort; the port should still be released after Stop().
            }

            _tcpListener.Stop();
            _tcpListener = null;
        }

        var shutdown = _tcpTask ?? Task.CompletedTask;
        await Task.WhenAny(shutdown, Task.Delay(TimeSpan.FromSeconds(2))).ConfigureAwait(false);
        _tcpTask = null;
        _cancellation?.Dispose();
        _cancellation = null;
    }

    private async Task AcceptTcpAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested && _tcpListener is not null)
        {
            TcpClient client;
            try
            {
                client = await _tcpListener.AcceptTcpClientAsync(cancellationToken);
            }
            catch
            {
                return;
            }
            _ = Task.Run(() => HandleSocksClientAsync(client, cancellationToken), cancellationToken);
        }
    }

    private async Task HandleSocksClientAsync(TcpClient client, CancellationToken cancellationToken)
    {
        using var clientScope = client;
        var stream = client.GetStream();
        var greeting = await ReadBytesAsync(stream, 2, cancellationToken);
        if (greeting[0] != 5) return;
        _ = await ReadBytesAsync(stream, greeting[1], cancellationToken);
        await stream.WriteAsync(new byte[] { 0x05, 0x00 }, cancellationToken);

        var requestPrefix = await ReadBytesAsync(stream, 4, cancellationToken);
        if (requestPrefix[0] != 5) return;
        var command = requestPrefix[1];
        var target = await ReadSocksEndpointAsync(stream, requestPrefix[3], cancellationToken);

        if (command == 1)
        {
            await HandleConnectAsync(client, stream, target.Host, target.Port, cancellationToken);
        }
        else if (command == 3)
        {
            await WriteSocksFailureAsync(stream, cancellationToken);
        }
        else
        {
            await WriteSocksFailureAsync(stream, cancellationToken);
        }
    }

    private async Task HandleConnectAsync(TcpClient socksClient, NetworkStream socksStream, string host, int port, CancellationToken cancellationToken)
    {
        using var proxyClient = new TcpClient();
        ConfigureTcpClient(socksClient);
        ConfigureTcpClient(proxyClient);
        await proxyClient.ConnectAsync(IPAddress.Loopback, AndroidHttpProxyPort, cancellationToken);
        await using var proxyStream = proxyClient.GetStream();
        await OpenHttpConnectAsync(proxyStream, host, port, cancellationToken);
        await WriteSocksSuccessAsync(socksStream, IPAddress.Loopback, 0, cancellationToken);

        var upload = Task.Run(async () =>
        {
            var buffer = new byte[64 * 1024];
            while (!cancellationToken.IsCancellationRequested)
            {
                var read = await socksStream.ReadAsync(buffer, cancellationToken);
                if (read == 0) break;
                AddOut(read);
                await proxyStream.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
            }
            proxyClient.Close();
        }, cancellationToken);

        var download = Task.Run(async () =>
        {
            var buffer = new byte[64 * 1024];
            while (!cancellationToken.IsCancellationRequested)
            {
                var read = await proxyStream.ReadAsync(buffer, cancellationToken);
                if (read == 0) break;
                AddIn(read);
                await socksStream.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
            }
            socksClient.Close();
        }, cancellationToken);

        await Task.WhenAny(upload, download);
    }

    private static async Task OpenHttpConnectAsync(NetworkStream stream, string host, int port, CancellationToken cancellationToken)
    {
        var request = Encoding.ASCII.GetBytes($"CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\nProxy-Connection: keep-alive\r\n\r\n");
        await stream.WriteAsync(request, cancellationToken);
        await stream.FlushAsync(cancellationToken);

        var response = new List<byte>(512);
        var buffer = new byte[1];
        while (response.Count < 8192)
        {
            var read = await stream.ReadAsync(buffer, cancellationToken);
            if (read == 0) break;
            response.Add(buffer[0]);
            if (response.Count >= 4 &&
                response[^4] == '\r' &&
                response[^3] == '\n' &&
                response[^2] == '\r' &&
                response[^1] == '\n')
            {
                break;
            }
        }

        var header = Encoding.ASCII.GetString(response.ToArray());
        if (!header.StartsWith("HTTP/1.1 200", StringComparison.OrdinalIgnoreCase) &&
            !header.StartsWith("HTTP/1.0 200", StringComparison.OrdinalIgnoreCase))
        {
            throw new IOException("Android proxy rejected CONNECT request.");
        }
    }

    private static async Task<SocksEndpoint> ReadSocksEndpointAsync(NetworkStream stream, byte addressType, CancellationToken cancellationToken)
    {
        string host = addressType switch
        {
            1 => new IPAddress(await ReadBytesAsync(stream, 4, cancellationToken)).ToString(),
            3 => Encoding.ASCII.GetString(await ReadBytesAsync(stream, (await ReadBytesAsync(stream, 1, cancellationToken))[0], cancellationToken)),
            4 => new IPAddress(await ReadBytesAsync(stream, 16, cancellationToken)).ToString(),
            _ => throw new InvalidOperationException("Unsupported SOCKS address type."),
        };
        var portBytes = await ReadBytesAsync(stream, 2, cancellationToken);
        return new SocksEndpoint(host, BinaryPrimitives.ReadUInt16BigEndian(portBytes));
    }

    private static async Task WriteSocksSuccessAsync(NetworkStream stream, IPAddress address, int port, CancellationToken cancellationToken)
    {
        var bytes = address.GetAddressBytes();
        var response = new byte[6 + bytes.Length];
        response[0] = 5;
        response[1] = 0;
        response[2] = 0;
        response[3] = (byte)(bytes.Length == 4 ? 1 : 4);
        bytes.CopyTo(response, 4);
        BinaryPrimitives.WriteUInt16BigEndian(response.AsSpan(4 + bytes.Length, 2), (ushort)port);
        await stream.WriteAsync(response, cancellationToken);
    }

    private static Task WriteSocksFailureAsync(NetworkStream stream, CancellationToken cancellationToken) =>
        stream.WriteAsync(new byte[] { 0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0 }, cancellationToken).AsTask();

    private static async Task<byte[]> ReadBytesAsync(NetworkStream stream, int length, CancellationToken cancellationToken)
    {
        var bytes = new byte[length];
        var offset = 0;
        while (offset < length)
        {
            var read = await stream.ReadAsync(bytes.AsMemory(offset), cancellationToken);
            if (read == 0) throw new IOException("Unexpected SOCKS disconnect.");
            offset += read;
        }
        return bytes;
    }

    private readonly record struct SocksEndpoint(string Host, int Port);

    private void AddOut(long bytes)
    {
        Interlocked.Add(ref _bytesOut, bytes);
        PublishTraffic();
    }

    private void AddIn(long bytes)
    {
        Interlocked.Add(ref _bytesIn, bytes);
        PublishTraffic();
    }

    private void PublishTraffic()
    {
        var now = Environment.TickCount64;
        var previous = Interlocked.Read(ref _lastTrafficPublishTicks);
        if (now - previous < 500)
        {
            return;
        }

        if (Interlocked.CompareExchange(ref _lastTrafficPublishTicks, now, previous) == previous)
        {
            _onTraffic(new TrafficStats(Interlocked.Read(ref _bytesOut), Interlocked.Read(ref _bytesIn)));
        }
    }

    private static void ConfigureTcpClient(TcpClient client)
    {
        client.NoDelay = true;
        client.Client.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.KeepAlive, true);
        client.ReceiveBufferSize = 128 * 1024;
        client.SendBufferSize = 128 * 1024;
    }
}
