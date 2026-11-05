# Viktrych hardware talk

Owner switch: `ai_voice`.

## What a page can hear

The talk control is a key or a media-session action that the browser actually delivers. Setup waits for that event and saves it only when it arrives. Power, volume, and assistant buttons are refused even if a name is typed, because ordinary web pages do not receive them. Nothing is substituted silently for those buttons.

On-screen talk stays available when the browser has on-device speech recognition. It is labeled as a fallback. Typing always works.

A saved letter key does not fire while the person is typing in a field. Function keys and media actions can.

## Low volume

Low-volume mode is a meter plus a sensitivity control. For a few seconds the page reads microphone level through an `AnalyserNode` on this device, then stops the tracks. That audio is not uploaded and is not sent to a speech service.

Where `getSupportedConstraints` lists them, higher sensitivity turns auto gain on and noise suppression off, so quiet speech is less likely to be removed. The browser speech recognizer still opens its own microphone. Changing constraints here does not mean the recognizer uses the same stream.

This app does not include a local whisper model. `SpeechRecognition` with `processLocally: true` only means the browser's own recognizer, when it exists, stays on the device. It is not a claim that whispers are understood. Quiet microphones, denied permission, and a missing recognizer fall back to typing.

## Before an action

Voice text is sent immediately only when whisper mode is off, the browser supplied a confidence of at least 0.72, and the phrase is not a consequential action such as block, delete, download, or apply. Otherwise the page shows the text and a confidence note, and waits for Send what I heard. Missing confidence counts as uncertain. Nothing is blocked, deleted, or posted from an uncertain phrase.
