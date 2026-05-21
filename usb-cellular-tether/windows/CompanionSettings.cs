using System.Text.Json;

namespace UsbCellularTether.Windows;

internal sealed class CompanionSettings
{
    private static readonly string SettingsPath = Path.Combine(AppContext.BaseDirectory, "companion-settings.json");

    public bool AutoStartWhenPhoneConnects { get; set; }
    public bool DisableWifiWhenActive { get; set; }
    public bool VerboseLogging { get; set; }
    public bool MinimizeToTrayWhileRunning { get; set; }
    public bool RestoreInternetOnStop { get; set; } = true;
    public bool ShowDetailedAdapterStats { get; set; } = true;
    public string? LastDeviceSerial { get; set; }

    public static CompanionSettings Load()
    {
        try
        {
            if (!File.Exists(SettingsPath))
            {
                return new CompanionSettings();
            }

            var json = File.ReadAllText(SettingsPath);
            return JsonSerializer.Deserialize<CompanionSettings>(json) ?? new CompanionSettings();
        }
        catch
        {
            return new CompanionSettings();
        }
    }

    public void Save()
    {
        try
        {
            var json = JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true });
            File.WriteAllText(SettingsPath, json);
        }
        catch (Exception ex)
        {
            AppLog.Write("Could not save settings: " + ex.Message);
        }
    }
}
