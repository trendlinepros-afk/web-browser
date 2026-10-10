; Registers Zirtola as a web browser for the current user, so it appears in
; Settings > Apps > Default apps and can open http/https links and .html files.
; Windows 11 only lets the user pick the default there; apps can't set it themselves.

!macro customInstall
  WriteRegStr HKCU "Software\Classes\ZirtolaURL" "" "Zirtola URL"
  WriteRegStr HKCU "Software\Classes\ZirtolaURL" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\ZirtolaURL\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\ZirtolaURL\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'

  WriteRegStr HKCU "Software\Classes\ZirtolaHTML" "" "Zirtola HTML Document"
  WriteRegStr HKCU "Software\Classes\ZirtolaHTML\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\ZirtolaHTML\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'

  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Zirtola" "" "Zirtola"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Zirtola\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Zirtola\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Zirtola\Capabilities" "ApplicationName" "Zirtola"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Zirtola\Capabilities" "ApplicationDescription" "Fast, private web browser"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Zirtola\Capabilities" "ApplicationIcon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Zirtola\Capabilities\StartMenu" "StartMenuInternet" "Zirtola"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Zirtola\Capabilities\URLAssociations" "http" "ZirtolaURL"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Zirtola\Capabilities\URLAssociations" "https" "ZirtolaURL"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Zirtola\Capabilities\FileAssociations" ".htm" "ZirtolaHTML"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Zirtola\Capabilities\FileAssociations" ".html" "ZirtolaHTML"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Zirtola\Capabilities\FileAssociations" ".shtml" "ZirtolaHTML"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Zirtola\Capabilities\FileAssociations" ".xhtml" "ZirtolaHTML"
  WriteRegStr HKCU "Software\RegisteredApplications" "Zirtola" "Software\Clients\StartMenuInternet\Zirtola\Capabilities"

  ; SHCNE_ASSOCCHANGED: let Explorer pick up the new registration.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  ; Updates run the old uninstaller first; keep the registration so a default-browser choice survives.
  ${ifNot} ${isUpdated}
    DeleteRegKey HKCU "Software\Classes\ZirtolaURL"
    DeleteRegKey HKCU "Software\Classes\ZirtolaHTML"
    DeleteRegKey HKCU "Software\Clients\StartMenuInternet\Zirtola"
    DeleteRegValue HKCU "Software\RegisteredApplications" "Zirtola"
    System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ${endIf}
!macroend
