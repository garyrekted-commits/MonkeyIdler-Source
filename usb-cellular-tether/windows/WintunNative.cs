using System.Runtime.InteropServices;

namespace UsbCellularTether.Windows;

internal static partial class WintunNative
{
    public const int PacketCapacity = 0x400000;
    public static readonly Guid AdapterGuid = Guid.Parse("9b77485d-42ad-4b96-9f4d-4bf453477e3c");

    public static void EnsureAvailable()
    {
        var localDll = Path.Combine(AppContext.BaseDirectory, "wintun.dll");
        if (!File.Exists(localDll))
        {
            throw new FileNotFoundException(
                "Network Adapter Mode requires wintun.dll next to the Windows companion executable. " +
                "Install Wintun/WireGuard runtime files, then restart the companion.",
                localDll);
        }
    }

    [LibraryImport("wintun.dll", StringMarshalling = StringMarshalling.Utf16)]
    public static partial IntPtr WintunCreateAdapter(string name, string tunnelType, in Guid requestedGuid);

    [LibraryImport("wintun.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool WintunCloseAdapter(IntPtr adapter);

    [LibraryImport("wintun.dll")]
    public static partial IntPtr WintunStartSession(IntPtr adapter, uint capacity);

    [LibraryImport("wintun.dll")]
    public static partial void WintunEndSession(IntPtr session);

    [LibraryImport("wintun.dll")]
    public static partial IntPtr WintunReceivePacket(IntPtr session, out uint packetSize);

    [LibraryImport("wintun.dll")]
    public static partial void WintunReleaseReceivePacket(IntPtr session, IntPtr packet);

    [LibraryImport("wintun.dll")]
    public static partial IntPtr WintunAllocateSendPacket(IntPtr session, uint packetSize);

    [LibraryImport("wintun.dll")]
    public static partial void WintunSendPacket(IntPtr session, IntPtr packet);
}
