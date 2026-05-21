using UsbCellularTether.Windows;

var tests = new (string Name, Action Test)[]
{
    ("Parses authorized and unauthorized ADB devices", ParsesAdbDevices),
    ("Formats local Windows proxy endpoint", FormatsProxyEndpoint),
};

var failures = 0;
foreach (var (name, test) in tests)
{
    try
    {
        test();
        Console.WriteLine($"PASS {name}");
    }
    catch (Exception ex)
    {
        failures++;
        Console.WriteLine($"FAIL {name}: {ex.Message}");
    }
}

if (failures > 0)
{
    Environment.ExitCode = 1;
}

static void ParsesAdbDevices()
{
    var output = string.Join(
        Environment.NewLine,
        "List of devices attached",
        "R5CT1234567\tdevice",
        "emulator-5554\tunauthorized",
        "");

    var devices = AdbDeviceParser.ParseDevices(output);

    AssertEqual(2, devices.Count);
    AssertEqual("R5CT1234567", devices[0].Serial);
    AssertEqual("device", devices[0].State);
    AssertEqual("emulator-5554", devices[1].Serial);
    AssertEqual("unauthorized", devices[1].State);
}

static void FormatsProxyEndpoint()
{
    AssertEqual("127.0.0.1:18080", WindowsProxySettings.FormatLocalProxy(18080));
}

static void AssertEqual<T>(T expected, T actual)
{
    if (!EqualityComparer<T>.Default.Equals(expected, actual))
    {
        throw new InvalidOperationException($"Expected {expected}, got {actual}.");
    }
}
