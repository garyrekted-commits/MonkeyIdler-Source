package com.example.usbcellulartether

import java.io.InputStream
import java.io.OutputStream
import java.nio.ByteBuffer

enum class FullTunnelMessageType(val code: Int) {
    OpenTcp(1),
    TcpData(2),
    CloseTcp(3),
    UdpData(4),
    Error(5);

    companion object {
        fun fromCode(code: Int): FullTunnelMessageType =
            entries.firstOrNull { it.code == code } ?: error("Unknown message type: $code")
    }
}

data class FullTunnelMessage(
    val type: FullTunnelMessageType,
    val sessionId: Int = 0,
    val host: String? = null,
    val port: Int = 0,
    val data: ByteArray = ByteArray(0),
)

class FullTunnelProtocol(private val input: InputStream, private val output: OutputStream) {
    @Synchronized
    fun writeTcpData(sessionId: Int, data: ByteArray) {
        writeTcpData(sessionId, data, data.size)
    }

    @Synchronized
    fun writeTcpData(sessionId: Int, data: ByteArray, length: Int) {
        val payloadLength = 1 + 4 + length
        val header = ByteArray(9)
        header.writeInt(0, payloadLength)
        header[4] = FullTunnelMessageType.TcpData.code.toByte()
        header.writeInt(5, sessionId)
        output.write(header)
        output.write(data, 0, length)
    }

    @Synchronized
    fun writeTcpDataCopying(sessionId: Int, data: ByteArray) {
        writeFrame(ByteArrayOutput().apply {
            writeByte(FullTunnelMessageType.TcpData.code)
            writeInt(sessionId)
            write(data)
        }.toByteArray())
    }

    @Synchronized
    fun writeCloseTcp(sessionId: Int) {
        writeFrame(ByteArrayOutput().apply {
            writeByte(FullTunnelMessageType.CloseTcp.code)
            writeInt(sessionId)
        }.toByteArray())
    }

    @Synchronized
    fun writeUdpData(host: String, port: Int, data: ByteArray) {
        val hostBytes = host.toByteArray(Charsets.UTF_8)
        writeFrame(ByteArrayOutput().apply {
            writeByte(FullTunnelMessageType.UdpData.code)
            writeShort(hostBytes.size)
            write(hostBytes)
            writeShort(port)
            writeInt(data.size)
            write(data)
        }.toByteArray())
    }

    fun read(): FullTunnelMessage? {
        val header = readExact(4) ?: return null
        val length = ByteBuffer.wrap(header).int
        require(length in 1..(1024 * 1024)) { "Invalid frame length: $length" }
        val payload = readExact(length) ?: return null
        var offset = 0
        val type = FullTunnelMessageType.fromCode(payload[offset++].toInt() and 0xff)

        return when (type) {
            FullTunnelMessageType.OpenTcp -> {
                val sessionId = payload.readInt(offset).also { offset += 4 }
                val hostLength = payload.readShort(offset).also { offset += 2 }
                val host = payload.decodeToString(offset, offset + hostLength)
                offset += hostLength
                val port = payload.readShort(offset)
                FullTunnelMessage(type, sessionId, host, port)
            }
            FullTunnelMessageType.TcpData,
            FullTunnelMessageType.CloseTcp,
            FullTunnelMessageType.Error -> {
                val sessionId = payload.readInt(offset).also { offset += 4 }
                FullTunnelMessage(type, sessionId, data = payload.copyOfRange(offset, payload.size))
            }
            FullTunnelMessageType.UdpData -> {
                val hostLength = payload.readShort(offset).also { offset += 2 }
                val host = payload.decodeToString(offset, offset + hostLength)
                offset += hostLength
                val port = payload.readShort(offset).also { offset += 2 }
                val dataLength = payload.readInt(offset).also { offset += 4 }
                FullTunnelMessage(type, host = host, port = port, data = payload.copyOfRange(offset, offset + dataLength))
            }
        }
    }

    private fun writeFrame(payload: ByteArray) {
        val header = ByteArray(4)
        header.writeInt(0, payload.size)
        output.write(header)
        output.write(payload)
        output.flush()
    }

    private fun readExact(length: Int): ByteArray? {
        val buffer = ByteArray(length)
        var offset = 0
        while (offset < length) {
            val read = input.read(buffer, offset, length - offset)
            if (read < 0) return null
            offset += read
        }
        return buffer
    }

    private fun ByteArray.readInt(offset: Int): Int = ByteBuffer.wrap(this, offset, 4).int
    private fun ByteArray.readShort(offset: Int): Int = ByteBuffer.wrap(this, offset, 2).short.toInt() and 0xffff
    private fun ByteArray.writeInt(offset: Int, value: Int) {
        this[offset] = (value ushr 24).toByte()
        this[offset + 1] = (value ushr 16).toByte()
        this[offset + 2] = (value ushr 8).toByte()
        this[offset + 3] = value.toByte()
    }
}

private class ByteArrayOutput {
    private val bytes = java.io.ByteArrayOutputStream()
    fun writeByte(value: Int) = bytes.write(value)
    fun writeInt(value: Int) = write(ByteBuffer.allocate(4).putInt(value).array())
    fun writeShort(value: Int) = write(ByteBuffer.allocate(2).putShort(value.toShort()).array())
    fun write(value: ByteArray) = bytes.write(value)
    fun toByteArray(): ByteArray = bytes.toByteArray()
}
