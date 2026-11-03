# Enable the TikTok workflows

The token used from automation cannot turn workflows on (`HTTP 403`).
These four were turned off by hand. Run this from a checkout that can
change Actions, then leave them on:

```sh
gh workflow enable "TikTok added accounts"
gh workflow enable "TikTok live"
gh workflow enable "TikTok record"
gh workflow enable "TikTok live upload"
```

Confirm with `gh workflow list --all` that each one says `active`.
Do not edit the workflow files. Auto-recording stays off until you turn
the server copy on in Shorts.
