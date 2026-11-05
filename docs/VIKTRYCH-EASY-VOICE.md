# Easy voice

Owner switch: `ai_easy_voice`.

Easy voice is a large Talk button on the app, plus a box you can type in. It uses the same on-device action list as Viktrych: open a page, open a profile you named, prepare a post or list draft, manage Home tabs, and block or mute only after you tap Do it for me. Safe setting changes, such as text size, also wait for that button. Nothing is published by voice.

## What it can see

Guidance reads the labels, roles, and links already drawn on this page. It scrolls a matching control into view, then draws a high-contrast ring only if the control is still on screen. A larger callout repeats that label. If the control is off screen, hidden, or more than one control matches, nothing is highlighted.

This is not OS screen vision. The page does not record the screen, take a screenshot, or send a picture to a vision service. No vision model is shipped. If one is added later, it has to be a model already downloaded on the device. Until then, pictures and complex media are not understood; the fallback is the visible text and labels.

## Speech

Talk asks the browser speech recognizer to stay on the device. The older browser recognizer, which may send audio away, stays off unless you allow it. If recognition is missing, denied, quiet, or unsure, you still have the typed box. Quiet speech runs a short microphone meter on the device and does not upload it. That meter is not a whisper model, and a whisper is not guaranteed on every microphone.

Reading aloud prefers a voice the browser marks as on-device. If every listed voice would leave the device, the app shows the words and does not speak them. Reduced motion turns off the moving highlight. Stop and Pause speaking are always available.

## Buttons the page cannot hear

Power, volume, and assistant buttons, including Bixby, are not intercepted. Setup saves a keyboard key or a media-session action only after that event arrives. The large Talk button remains the control on the screen.
