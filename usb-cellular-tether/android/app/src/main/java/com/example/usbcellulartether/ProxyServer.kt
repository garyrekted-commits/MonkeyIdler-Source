package com.example.usbcellulartether

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.BufferedReader
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.InputStreamReader
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URI
import java.util.Locale
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import kotlin.concurrent.thread

class ProxyServer(
    context: Context,
    private val port: Int = 28080,
    private val onStats: (ProxyStats) -> Unit,
) {
    private val appContext = context.applicationContext
    private val clientPool = Executors.newCachedThreadPool()
    private val activeConnections = AtomicInteger()
    private val totalConnections = AtomicLong()
    private val bytesFromComputer = AtomicLong()
    private val bytesToComputer = AtomicLong()
    @Volatile private var serverSocket: ServerSocket? = null
    @Volatile private var running = false
    @Volatile private var lastError: String? = null

    fun start() {
        if (running) return

        running = true
        lastError = null
        publish("Starting")

        thread(name = "usb-tether-proxy-listener", isDaemon = true) {
            try {
                ServerSocket(port, 50, InetAddress.getByName("127.0.0.1")).use { socket ->
                    serverSocket = socket
                    publish("Waiting for PC")

                    while (running) {
                        val client = socket.accept()
                        totalConnections.incrementAndGet()
                        activeConnections.incrementAndGet()
                        publish("Connected")
                        clientPool.execute { handleClient(client) }
                    }
                }
            } catch (ex: IOException) {
                if (running) {
                    lastError = ex.message ?: ex.javaClass.simpleName
                    publish("Error")
                }
            } finally {
                running = false
                serverSocket = null
                publish("Stopped")
            }
        }
    }

    fun stop() {
        running = false
        serverSocket?.closeQuietly()
        clientPool.shutdownNow()
        publish("Stopped")
    }

    private fun handleClient(client: Socket) {
        client.use { local ->
            try {
                local.tcpNoDelay = true
                local.keepAlive = true
                local.soTimeout = 0
                val input = BufferedInputStream(local.getInputStream())
                val output = BufferedOutputStream(local.getOutputStream())
                val request = readHttpRequest(input)

                if (request.firstLine.isBlank()) return

                val method = request.firstLine.substringBefore(' ').uppercase(Locale.US)
                if (method == "CONNECT") {
                    handleConnect(local, request, input, output)
                } else {
                    handleHttp(local, request, input, output)
                }
            } catch (ex: Exception) {
                lastError = ex.message ?: ex.javaClass.simpleName
                publish(if (running) "Connected" else "Stopped")
            } finally {
                activeConnections.decrementAndGet()
                publish(if (running && activeConnections.get() == 0) "Waiting for PC" else currentState())
            }
        }
    }

    private fun handleConnect(client: Socket, request: HttpRequest, clientInput: InputStream, clientOutput: OutputStream) {
        val target = request.firstLine.split(' ').getOrNull(1).orEmpty()
        val host = target.substringBefore(':')
        val targetPort = target.substringAfter(':', "443").toIntOrNull() ?: 443

        connectToTarget(host, targetPort).use { remote ->
            clientOutput.write("HTTP/1.1 200 Connection Established\r\n\r\n".toByteArray())
            clientOutput.flush()
            relayBothWays(client, clientInput, clientOutput, remote)
        }
    }

    private fun handleHttp(client: Socket, request: HttpRequest, clientInput: InputStream, clientOutput: OutputStream) {
        val parts = request.firstLine.split(' ')
        if (parts.size < 3) {
            clientOutput.write("HTTP/1.1 400 Bad Request\r\n\r\n".toByteArray())
            clientOutput.flush()
            return
        }

        val uri = URI(parts[1])
        val host = uri.host ?: request.headers["host"]?.substringBefore(':')
        if (host.isNullOrBlank()) {
            clientOutput.write("HTTP/1.1 400 Bad Request\r\n\r\n".toByteArray())
            clientOutput.flush()
            return
        }

        val targetPort = if (uri.port > 0) uri.port else 80
        val path = buildString {
            append(if (uri.rawPath.isNullOrBlank()) "/" else uri.rawPath)
            if (!uri.rawQuery.isNullOrBlank()) append('?').append(uri.rawQuery)
        }

        connectToTarget(host, targetPort).use { remote ->
            val remoteOutput = BufferedOutputStream(remote.getOutputStream())
            val rewrittenRequest = buildString {
                append(parts[0]).append(' ').append(path).append(' ').append(parts[2]).append("\r\n")
                request.rawHeaders.forEach { header ->
                    if (!header.startsWith("Proxy-Connection:", ignoreCase = true)) {
                        append(header).append("\r\n")
                    }
                }
                append("\r\n")
            }.toByteArray()

            remoteOutput.write(rewrittenRequest)
            remoteOutput.flush()
            bytesFromComputer.addAndGet(rewrittenRequest.size.toLong())
            relayBothWays(client, clientInput, clientOutput, remote)
        }
    }

    private fun connectToTarget(host: String, port: Int): Socket {
        val socket = createCellularSocket(host, port)
        socket.tcpNoDelay = true
        socket.keepAlive = true
        socket.soTimeout = 0
        return socket
    }

    private fun createCellularSocket(host: String, port: Int): Socket {
        val connectivity = appContext.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val cellularNetwork = connectivity.allNetworks.firstOrNull { network ->
            connectivity.getNetworkCapabilities(network)
                ?.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) == true
        }
        return if (cellularNetwork != null) {
            cellularNetwork.socketFactory.createSocket(host, port)
        } else {
            Socket(host, port)
        }
    }

    private fun relayBothWays(client: Socket, clientInput: InputStream, clientOutput: OutputStream, remote: Socket) {
        remote.soTimeout = 0
        val remoteInput = BufferedInputStream(remote.getInputStream())
        val remoteOutput = BufferedOutputStream(remote.getOutputStream())

        val upstream = thread(name = "usb-tether-upstream", isDaemon = true) {
            try {
                copyUntilClosed(clientInput, remoteOutput, bytesFromComputer)
            } finally {
                remote.closeQuietly()
                client.closeQuietly()
            }
        }
        val downstream = thread(name = "usb-tether-downstream", isDaemon = true) {
            try {
                copyUntilClosed(remoteInput, clientOutput, bytesToComputer)
            } finally {
                remote.closeQuietly()
                client.closeQuietly()
            }
        }

        downstream.join()
        upstream.join()
    }

    private fun copyUntilClosed(input: InputStream, output: OutputStream, counter: AtomicLong) {
        val buffer = ByteArray(PROXY_BUFFER_SIZE)
        while (running) {
            val read = try {
                input.read(buffer)
            } catch (_: IOException) {
                break
            }
            if (read < 0) break
            try {
                output.write(buffer, 0, read)
                counter.addAndGet(read.toLong())
                publish("Connected")
            } catch (_: IOException) {
                break
            }
        }
    }

    private fun readHttpRequest(input: InputStream): HttpRequest {
        val headerBytes = ByteArrayOutputStream()
        var previous = -1
        var current: Int
        var matchCount = 0

        while (headerBytes.size() < MAX_HEADER_BYTES) {
            current = input.read()
            if (current < 0) break
            headerBytes.write(current)

            matchCount = when {
                previous == '\r'.code && current == '\n'.code && matchCount == 0 -> 1
                previous == '\n'.code && current == '\r'.code && matchCount == 1 -> 2
                previous == '\r'.code && current == '\n'.code && matchCount == 2 -> 3
                else -> 0
            }
            if (matchCount == 3) break
            previous = current
        }

        val headerText = headerBytes.toString(Charsets.ISO_8859_1.name())
        val lines = headerText.split("\r\n").filter { it.isNotEmpty() }
        val firstLine = lines.firstOrNull().orEmpty()
        val rawHeaders = lines.drop(1)
        val headers = rawHeaders.mapNotNull { line ->
            val separator = line.indexOf(':')
            if (separator <= 0) null else line.substring(0, separator).lowercase(Locale.US) to line.substring(separator + 1).trim()
        }.toMap()

        return HttpRequest(firstLine, rawHeaders, headers)
    }

    private fun currentState(): String =
        when {
            !running -> "Stopped"
            activeConnections.get() > 0 -> "Connected"
            else -> "Waiting for PC"
        }

    private fun publish(state: String) {
        onStats(
            ProxyStats(
                state = state,
                listenPort = port,
                activeConnections = activeConnections.get().coerceAtLeast(0),
                totalConnections = totalConnections.get(),
                bytesFromComputer = bytesFromComputer.get(),
                bytesToComputer = bytesToComputer.get(),
                lastError = lastError,
            ),
        )
    }

    private data class HttpRequest(
        val firstLine: String,
        val rawHeaders: List<String>,
        val headers: Map<String, String>,
    )

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

    companion object {
        private const val MAX_HEADER_BYTES = 64 * 1024
        private const val PROXY_BUFFER_SIZE = 64 * 1024
    }
}
