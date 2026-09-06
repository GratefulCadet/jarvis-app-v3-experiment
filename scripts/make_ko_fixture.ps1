# -*- coding: utf-8 -*-
<#
  data/voice_stt_fixtures/ko_hello_jarvis.wav 생성 스크립트
  용도: STT 검증용 한국어 음성 fixture (합성 생성, 실시간 마이크 아님)
  합성 엔진을 런타임 TTS로 쓰지 않는다 — 오직 fixture 생성용.
#>
param(
    [string]$OutPath = "C:\Users\USER\Documents\JARVIS\jarvis-app-v3-harness\data\voice_stt_fixtures\ko_hello_jarvis.wav",
    [string]$Text = "안녕하세요 자비스, 현재 진행 중인 할 일 목록을 보여줘",
    [string]$VoiceName = "Microsoft Heami Desktop",
    [int]$Rate = 1
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Speech

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    try {
        $synth.SelectVoice($VoiceName)
        Write-Output "선택한 음성: $VoiceName"
    } catch {
        $available = $synth.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name }
        Write-Warning "음성 '$VoiceName'을(를) 선택하지 못함. 사용 가능 목록:"
        $available | ForEach-Object { Write-Warning "  - $_" }
        $ko = $available | Where-Object { $_ -match "Heami|Korean|한국어|ko" } | Select-Object -First 1
        if ($ko) {
            $synth.SelectVoice($ko)
            Write-Output "대신 한국어 계열 음성 선택: $ko"
        } else {
            Write-Output "한국어 음성을 찾지 못해 기본 음성을 사용"
        }
    }
    $synth.Rate = $Rate
    Write-Output "텍스트: $Text"
    Write-Output "출력: $OutPath"

    $dir = Split-Path $OutPath -Parent
    if (-not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }

    $synth.SetOutputToWaveFile($OutPath)
    $synth.Speak($Text)
    $synth.SetOutputToDefaultAudioDevice()
} finally {
    $synth.Dispose()
}

if (Test-Path $OutPath) {
    $bytes = [System.IO.File]::ReadAllBytes($OutPath)
    $len = $bytes.Length
    Write-Output "생성됨: $OutPath  ($len bytes)"
} else {
    throw "출력 파일을 생성하지 못함: $OutPath"
}
