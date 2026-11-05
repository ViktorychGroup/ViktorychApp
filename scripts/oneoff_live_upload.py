import json, os, sys, time
from pathlib import Path
sys.path.insert(0, '/workspace/wt-hf-tiktok/docker/tiktok-live')
import fullvideo

source = Path('/tmp/oneoff/source.mkv')
work = Path('/tmp/oneoff/work')
work.mkdir(parents=True, exist_ok=True)
sender = fullvideo.pick_sender(os.environ['TELEGRAM_BOT_TOKEN'])
channel = os.environ['TELEGRAM_CHANNEL_ID']
handle = os.environ.get('ONEOFF_HANDLE', 'live')
# Remux only: no video or audio re-encoding.
mp4 = work / 'original.mp4'
if not fullvideo._run(['ffmpeg','-hide_banner','-loglevel','error','-y','-i',str(source),'-map','0','-c','copy','-movflags','+faststart',str(mp4)]):
    raise RuntimeError('lossless remux failed')
files = fullvideo.split_to_limit(mp4, work / 'parts', sender.limit)
if not files:
    raise RuntimeError('could not make Telegram-sized copy-only pieces')
ids = []
for n, path in enumerate(files, 1):
    meta = fullvideo.probe(path)
    caption = '@%s LIVE · original source' % handle
    if len(files) > 1:
        caption += ' · %d/%d' % (n, len(files))
    message = sender.send(channel, path, caption, meta, None)
    if not message:
        raise RuntimeError('Telegram returned no message id')
    ids.append(message)
    print('telegram_message_id=%d' % message, flush=True)
    time.sleep(3)
Path('/tmp/oneoff/receipt.json').write_text(json.dumps({'handle':handle,'messages':ids,'files':len(files),'sender':sender.name}))
print('UPLOAD_CONFIRMED', flush=True)
