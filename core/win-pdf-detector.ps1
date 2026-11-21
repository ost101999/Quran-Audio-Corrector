$ErrorActionPreference = 'SilentlyContinue'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WinPdfHelper {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  public static string GetText(IntPtr h) {
    var sb = new StringBuilder(512);
    GetWindowText(h, sb, 512);
    return sb.ToString();
  }
  public static List<string> ListVisibleTitles() {
    var list = new List<string>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      string t = GetText(h);
      if (!string.IsNullOrWhiteSpace(t)) list.Add(t);
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
"@

$uia = [System.Windows.Automation.AutomationElement]
$root = $uia::RootElement
$tabCond = New-Object System.Windows.Automation.PropertyCondition($uia::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)
$listCond = New-Object System.Windows.Automation.PropertyCondition($uia::ControlTypeProperty, [System.Windows.Automation.ControlType]::ListItem)
$selCond = New-Object System.Windows.Automation.OrCondition($tabCond, $listCond)

Write-Output '{"ready":true}'
[Console]::Out.Flush()

while (($line = [Console]::In.ReadLine()) -ne $null) {
  try {
    $fgHwnd = [WinPdfHelper]::GetForegroundWindow()
    $fgTitle = [WinPdfHelper]::GetText($fgHwnd)
    $allTitles = [WinPdfHelper]::ListVisibleTitles()
    $pdfTitles = @($allTitles | Where-Object { $_ -match 'Xodo|Acrobat|\.pdf' })

    $selectedTabs = New-Object System.Collections.Generic.List[string]
    $allTabNames = New-Object System.Collections.Generic.List[string]
    $xodoWinNames = New-Object System.Collections.Generic.List[string]

    $wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($w in $wins) {
      $wName = $w.Current.Name
      $wClass = $w.Current.ClassName
      if ($wName -match 'Xodo|Acrobat|\.pdf' -or $wClass -eq 'ApplicationFrameWindow') {
        $xodoWinNames.Add("$wClass|$wName")
        if ($wName -match 'Xodo' -or $wClass -eq 'ApplicationFrameWindow') {
          $items = $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, $selCond)
          foreach ($it in $items) {
            $n = $it.Current.Name
            if (-not [string]::IsNullOrWhiteSpace($n)) {
              $allTabNames.Add($n)
              try {
                $pat = $it.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
                if ($pat.Current.IsSelected) {
                  $selectedTabs.Add($n)
                }
              } catch {}
            }
          }
        }
      }
    }

    $payload = @{
      fgTitle = $fgTitle
      pdfTitles = $pdfTitles
      xodoWinNames = @($xodoWinNames)
      selectedTabs = @($selectedTabs)
      allTabs = @($allTabNames | Select-Object -Unique | Select-Object -First 20)
    } | ConvertTo-Json -Compress -Depth 4
    Write-Output $payload
  } catch {
    Write-Output ('{"error":' + ($_.Exception.Message | ConvertTo-Json -Compress) + '}')
  }
  [Console]::Out.Flush()
}
