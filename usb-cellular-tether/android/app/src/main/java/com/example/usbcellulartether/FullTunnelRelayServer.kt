package com.example.usbcellulartether

import android.content.Context
import java.io.IOException
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import kotlin.concurrent.thread

class FullTunnelRelayServer(context: Context) {
    private val appContext = context.applicationContext
    private val tcpSessions = ConcurrentHashMap<Int, Socket>()
    @Volatile private var serverSocket: ServerSocket? = null
    @Volatile private var running = false

    fun start() {
        if (running) return
        running = true
        thread(name = "usb-full-relay-listener", isDaemon = true) {
            ServerSocket(PORT, 16, InetAddress.getByName("127.0.0.1")).use { server ->
                serverSocket = server
                while (running) {
                    val client = try {
                        server.accept()
                    } catch (_: IOException) {
                        break
                    }
                    client.configureForTunnel()
                    thread(name = "usb-full-relay-client", isDaemon = true) {
                        handleClient(client)
                    }
                }
            }
        }
    }

    fun stop() {
        running = false
        serverSocket?.closeQuietly()
        serverSocket = null
        tcpSessions.values.forEach { it.closeQuietly() }
        tcpSessions.clear()
    }

    private fun handleClient(client: Socket) {
        try {
            client.use { socket ->
                val protocol = FullTunnelProtocol(socket.getInputStream(), socket.getOutputStream())
                val udpSessions = ConcurrentHashMap<String, UdpSession>()
                try {
                    while (running) {
                        val message = try {
                            protocol.read()
                        } catch (_: Exception) {
                            break
                        } ?: break

                        when (message.type) {
                            FullTunnelMessageType.OpenTcp -> openTcp(protocol, message)
                            FullTunnelMessageType.TcpData -> writeTcpToRemote(message)
                            FullTunnelMessageType.CloseTcp -> closeTcp(message.sessionId)
                            FullTunnelMessageType.UdpData -> relayUdp(protocol, message, udpSessions)
                            FullTunnelMessageType.Error -> closeTcp(message.sessionId)
                        }
                    }
                } finally {
                    udpSessions.values.forEach { it.close() }
                }
            }
        } catch (_: Exception) {
            // USB disconnects and closed sockets are normal while Windows stops the tunnel.
        }
    }

    private fun openTcp(protocol: FullTunnelProtocol, message: FullTunnelMessage) {
        val host = message.host ?: return
        val remote = try {
            createSocket(host, message.port)
        } catch (_: IOException) {
            protocol.writeCloseTcpQuietly(message.sessionId)
            return
        }
        remote.configureForTunnel()
        tcpSessions[message.sessionId] = remote
        thread(name = "usb-full-relay-tcp-${message.sessionId}", isDaemon = true) {
            val buffer = ByteArray(32 * 1024)
            try {
                val input = remote.getInputStream()
                while (running) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    protocol.writeTcpData(message.sessionId, buffer, read)
                }
            } catch (_: IOException) {
            } finally {
                closeTcp(message.sessionId)
                protocol.writeCloseTcpQuietly(message.sessionId)
            }
        }
    }

    private fun writeTcpToRemote(message: FullTunnelMessage) {
        try {
            tcpSessions[message.sessionId]?.getOutputStream()?.write(message.data)
        } catch (_: IOException) {
            closeTcp(message.sessionId)
        }
    }

    private fun closeTcp(sessionId: Int) {
        tcpSessions.remove(sessionId)?.closeQuietly()
    }

    private fun relayUdp(
        protocol: FullTunnelProtocol,
        message: FullTunnelMessage,
        udpSessions: ConcurrentHashMap<String, UdpSession>,
    ) {
        val host = message.host ?: return
        val key = "$host:${message.port}"
        try {
            val session = udpSessions.computeIfAbsent(key) {
                createUdpSession(protocol, host, message.port, udpSessions, key)
            }
            session.send(message.data)
        } catch (_: IOException) {
            udpSessions.remove(key)?.close()
        } catch (_: RuntimeException) {
            udpSessions.remove(key)?.close()
        }
    }

    private fun createUdpSession(
        protocol: FullTunnelProtocol,
        host: String,
        port: Int,
        udpSessions: ConcurrentHashMap<String, UdpSession>,
        key: String,
    ): UdpSession {
        val target = InetAddress.getByName(host)
        val socket = DatagramSocket()
        socket.receiveBufferSize = TUNNEL_SOCKET_BUFFER_SIZE
        socket.sendBufferSize = TUNNEL_SOCKET_BUFFER_SIZE
        socket.soTimeout = UDP_IDLE_TIMEOUT_MS
        val session = UdpSession(socket, target, port)

        thread(name = "usb-full-relay-udp-$key", isDaemon = true) {
            val buffer = ByteArray(64 * 1024)
            try {
                while (running && !socket.isClosed) {
                    val response = DatagramPacket(buffer, buffer.size)
                    socket.receive(response)
                    protocol.writeUdpData(
                        response.address.hostAddress ?: host,
                        response.port,
                        response.data.copyOf(response.length),
                    )
                }
            } catch (_: IOException) {
            } finally {
                udpSessions.remove(key)?.close()
            }
        }

        return session
    }

    private fun createSocket(host: String, port: Int): Socket {
        return Socket(host, port)
    }

    private fun Socket.configureForTunnel() {
        tcpNoDelay = true
        keepAlive = true
        receiveBufferSize = TUNNEL_SOCKET_BUFFER_SIZE
        sendBufferSize = TUNNEL_SOCKET_BUFFER_SIZE
    }

    private fun Socket.closeQuietly() {
        try {
            close()
        } catch (_: IOException) {
        }
    }

    private fun ServerSocket.closeQuietly() {
        try {
            close()
        } catch (_: IOException) {
        }
    }

    private fun FullTunnelProtocol.writeCloseTcpQuietly(sessionId: Int) {
        try {
            writeCloseTcp(sessionId)
        } catch (_: IOException) {
        }
    }

    private class UdpSession(
        private val socket: DatagramSocket,
        private val target: InetAddress,
        private val port: Int,
    ) {
        @Synchronized
        fun send(data: ByteArray) {
            socket.send(DatagramPacket(data, data.size, target, port))
        }

        fun close() {
            socket.close()
        }
    }

    companion object {
        const val PORT = 28082
        private const val TUNNEL_SOCKET_BUFFER_SIZE = 128 * 1024
        private const val UDP_IDLE_TIMEOUT_MS = 30_000
    }
}
