"""Normalize a public VK wall.get document into the shared post shape.

The live sync builds that document in vk_remote. Tests use a saved fixture.
Photo and video files stay on VK's CDN. A video page that does not include an
mp4 is kept as a poster plus the original link.
"""

from __future__ import annotations

import re
import urllib.parse

from .common import clean_text, parse_json_loose, post_shell, profile_url, to_iso

MARK = re.compile(r"\[([^\[\]|]+)\|([^\[\]]+)\]")
AWAY = re.compile(r"https?://(?:m\.)?vk\.com/away\.php\?[^ \n]*", re.I)


def _unwrap(url: str) -> str:
    parsed = urllib.parse.urlparse(url or "")
    if parsed.path.rstrip("/").endswith("away.php"):
        target = urllib.parse.parse_qs(parsed.query).get("to") or []
        if target and target[0].startswith("http"):
            return target[0]
    return url


def vk_text(value: str) -> tuple[str, list]:
    links = []

    def repl(match: re.Match) -> str:
        target, label = match.group(1).strip(), match.group(2).strip()
        if target.startswith("http"):
            href = _unwrap(target)
            links.append({"expanded": href, "display": label or href, "anchorText": label or href})
            return label or href
        return label

    text = MARK.sub(repl, value or "")
    text = AWAY.sub(lambda match: _unwrap(match.group(0)), text)
    return clean_text(text), links


def _best_url(rows: list) -> str:
    best = ""
    area = -1
    for row in rows or []:
        if not isinstance(row, dict) or not row.get("url"):
            continue
        width = int(row.get("width") or 0)
        height = int(row.get("height") or 0)
        if width * height >= area:
            best = row["url"]
            area = width * height
    return best


def _photo(photo: dict) -> dict | None:
    url = _best_url(photo.get("sizes") or [])
    if not url:
        url = ((photo.get("orig_photo") or {}) if isinstance(photo.get("orig_photo"), dict) else {}).get("url") or ""
    if not url:
        return None
    return {"type": "photo", "url": url, "poster": url, "alt": photo.get("text") or ""}


def _size(value) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def _best_row(rows: list) -> dict:
    best = {}
    area = -1
    for row in rows or []:
        if not isinstance(row, dict) or not row.get("url"):
            continue
        size = _size(row.get("width")) * _size(row.get("height"))
        if size >= area:
            best = row
            area = size
    return best


def _video_frame(video: dict) -> tuple[str, int, int]:
    """Pick the poster and the real frame size of a VK video.

    VK pads its cover images to a fixed landscape box for vertical clips
    (`with_padding`). Those padded covers would give the feed tile the wrong
    shape, so the frame size comes from the video itself, then the first
    frame, then an unpadded cover. A padded cover is only a last-resort poster
    and never sets the size.
    """
    images = [row for row in (video.get("image") or []) if isinstance(row, dict)]
    clean = [row for row in images if not row.get("with_padding")]
    padded = [row for row in images if row.get("with_padding")]
    first = _best_row(video.get("first_frame") or [])
    cover = _best_row(clean)
    poster = cover.get("url") or first.get("url") or _best_row(padded).get("url") or ""
    width, height = _size(video.get("width")), _size(video.get("height"))
    if not (width and height):
        for row in (first, cover):
            width, height = _size(row.get("width")), _size(row.get("height"))
            if width and height:
                break
        else:
            width, height = 0, 0
    return poster, width, height


def _video(video: dict) -> dict | None:
    if not isinstance(video, dict):
        return None
    poster, width, height = _video_frame(video)
    owner = video.get("owner_id")
    vid = video.get("id")
    page = f"https://vk.com/video{owner}_{vid}" if owner is not None and vid is not None else ""
    files = video.get("files") if isinstance(video.get("files"), dict) else {}
    direct = ""
    for key in ("mp4_720", "mp4_480", "mp4_360", "mp4_240", "hls"):
        if files.get(key):
            direct = files[key]
            break
    if not direct and not poster and not page:
        return None
    media = {"type": "video", "url": direct or page, "poster": poster}
    if width and height:
        media["width"] = width
        media["height"] = height
    if video.get("duration"):
        media["duration"] = int(video["duration"])
    if page:
        media["open"] = page
    if video.get("title"):
        media["title"] = video["title"]
    return media


def _attachments(rows: list) -> tuple[list, list, list]:
    media = []
    links = []
    notes = []
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        kind = row.get("type") or ""
        obj = row.get(kind) if isinstance(row.get(kind), dict) else {}
        if kind == "photo":
            photo = _photo(obj)
            if photo:
                media.append(photo)
        elif kind == "video":
            video = _video(obj)
            if video:
                media.append(video)
        elif kind == "link" and obj.get("url"):
            href = _unwrap(obj["url"])
            title = obj.get("title") or href
            links.append({"expanded": href, "display": title, "anchorText": title})
            photo = obj.get("photo") if isinstance(obj.get("photo"), dict) else {}
            picture = _photo(photo) if photo else None
            if picture:
                media.append(picture)
        elif kind == "poll":
            question = (obj.get("question") or "").strip()
            if question:
                notes.append("Poll: " + question)
    return media, links, notes


def _people(payload: dict) -> dict:
    found = {}
    response = payload.get("response") if isinstance(payload, dict) else {}
    if not isinstance(response, dict):
        return found
    for row in response.get("groups") or []:
        if not isinstance(row, dict) or row.get("id") is None:
            continue
        screen = row.get("screen_name") or ""
        found[-abs(int(row["id"]))] = {
            "name": row.get("name") or screen,
            "handle": screen,
            "avatar": row.get("photo_200") or row.get("photo_100") or "",
        }
    for row in response.get("profiles") or []:
        if not isinstance(row, dict) or row.get("id") is None:
            continue
        name = row.get("name") or " ".join(part for part in (row.get("first_name"), row.get("last_name")) if part)
        screen = row.get("screen_name") or row.get("domain") or ""
        found[int(row["id"])] = {
            "name": name or screen,
            "handle": screen,
            "avatar": row.get("photo_100") or row.get("photo_200") or "",
        }
    return found


def _person(people: dict, owner_id) -> dict:
    try:
        key = int(owner_id)
    except (TypeError, ValueError):
        return {"name": "", "handle": "", "avatar": ""}
    return dict(people.get(key) or {"name": "", "handle": str(key), "avatar": ""})


def _stats(item: dict) -> dict:
    def count(block, key="count"):
        if not isinstance(block, dict):
            return 0
        try:
            return int(block.get(key) or 0)
        except (TypeError, ValueError):
            return 0

    stats = {
        "likes": count(item.get("likes")),
        "reposts": count(item.get("reposts")),
        "replies": count(item.get("comments")),
        "views": count(item.get("views")),
    }
    return {key: value for key, value in stats.items() if value}


def _wall_url(owner_id, post_id) -> str:
    return f"https://vk.com/wall{owner_id}_{post_id}"


def _followed_id(people: dict, feed: dict):
    wanted = str(feed.get("handle") or "").lstrip("@").lower()
    if not wanted:
        return None
    for key, person in people.items():
        try:
            owner = int(key)
        except (TypeError, ValueError):
            continue
        if owner < 0 and str(person.get("handle") or "").lower() == wanted:
            return owner
    return None


def _reposter(people: dict, owner_id, feed: dict) -> dict:
    person = _person(people, owner_id)
    return {
        "name": person.get("name") or feed.get("handle") or "",
        "handle": person.get("handle") or feed.get("handle") or "",
        "avatar": person.get("avatar") or "",
        "platform": feed.get("platform") or "vk",
        "feedId": feed.get("id") or "",
    }


def _carried_on_wall(item: dict, followed) -> bool:
    """Another community's post placed on this wall, without copy_history."""
    if followed is None:
        return False
    try:
        owner = int(item.get("owner_id"))
    except (TypeError, ValueError):
        return False
    if owner == followed:
        return False
    found = []
    co = item.get("coowners") if isinstance(item.get("coowners"), dict) else {}
    for row in co.get("list") or []:
        if isinstance(row, dict) and row.get("owner_id") is not None:
            found.append(row.get("owner_id"))
    co_post = co.get("coowner_post_id") if isinstance(co.get("coowner_post_id"), dict) else {}
    if co_post.get("owner_id") is not None:
        found.append(co_post.get("owner_id"))
    header = item.get("header") if isinstance(item.get("header"), dict) else {}
    title = header.get("title") if isinstance(header.get("title"), dict) else {}
    for raw in title.get("source_ids") or []:
        found.append(raw)
    for raw in found:
        try:
            if int(raw) == followed:
                return True
        except (TypeError, ValueError):
            continue
    return False


def _one(item: dict, feed: dict, people: dict, nested: bool = False) -> dict | None:
    if not isinstance(item, dict):
        return None
    if item.get("post_type") in ("postpone", "suggest"):
        return None
    owner_id = item.get("owner_id")
    post_id = item.get("id")
    if owner_id is None or post_id is None:
        return None
    text, links = vk_text(item.get("text") or "")
    media, more_links, notes = _attachments(item.get("attachments") or [])
    links = links + more_links
    if notes:
        text = (text + "\n" + "\n".join(notes)).strip()
    copies = [row for row in (item.get("copy_history") or []) if isinstance(row, dict)]
    original = _one(copies[0], feed, people, nested=True) if copies else None
    author = _person(people, item.get("from_id") if item.get("from_id") is not None else owner_id)
    handle = author.get("handle") or feed.get("handle") or ""
    kind = "post"
    reposted = None
    quoted = None
    if original and not nested:
        same = text.strip() == str(original.get("text") or "").strip()
        if text and not same:
            kind = "quote"
            quoted = original
        else:
            kind = "repost"
            reposted = _reposter(people, owner_id, feed)
            text = original.get("text") or ""
            links = original.get("links") or links
            media = original.get("media") or media
            author = {"name": original.get("author") or "", "handle": original.get("handle") or "", "avatar": original.get("avatar") or ""}
            handle = author.get("handle") or handle
    elif not nested and kind == "post" and _carried_on_wall(item, _followed_id(people, feed)):
        kind = "repost"
        reposted = _reposter(people, _followed_id(people, feed), feed)
    status_id = f"{owner_id}_{post_id}"
    return post_shell(
        id=status_id,
        statusId=status_id,
        platform="vk",
        feedId=feed.get("id") or "",
        kind=kind,
        author=author.get("name") or handle,
        handle=handle,
        avatar=author.get("avatar") or "",
        verifiedType=None,
        text=text,
        links=links,
        date=to_iso(item.get("date")),
        url=_wall_url(owner_id, post_id),
        media=media,
        repostedBy=reposted,
        quoted=quoted,
        stats=_stats(item),
    )


def _owner_id(group: dict) -> str:
    try:
        number = int(group.get("id"))
    except (TypeError, ValueError):
        return ""
    if number == 0:
        return ""
    if str(group.get("type") or "page").lower() == "profile":
        return str(abs(number))
    return str(-abs(number))


def _pick_group(groups: list, feed: dict, response: dict) -> tuple[dict, bool]:
    """The added account, not the first community mentioned on the wall."""
    stored = str(feed.get("permanentId") or "")
    wanted = (feed.get("handle") or "").lstrip("@").lower()
    if stored:
        for row in groups:
            if _owner_id(row) == stored:
                return row, True
    for row in groups:
        if (row.get("screen_name") or "").lower() == wanted and wanted:
            return row, True
    owners = []
    for item in response.get("items") or []:
        if isinstance(item, dict) and item.get("owner_id") is not None:
            owners.append(str(item.get("owner_id")))
    if owners and not stored:
        top = max(set(owners), key=owners.count)
        for row in groups:
            if _owner_id(row) == top:
                return row, True
    if groups:
        return groups[0], False
    return {}, False


def _profile(group: dict, feed: dict, post_count, account: bool = False) -> dict:
    handle = (group.get("screen_name") or feed.get("handle") or "").lstrip("@")
    name = group.get("name") or handle
    images = ((group.get("cover") or {}) if isinstance(group.get("cover"), dict) else {}).get("images") or []
    banner = images[-1].get("url") if images and isinstance(images[-1], dict) else ""
    website = group.get("site") or ""
    if website and not website.startswith("http"):
        website = "https://" + website
    profile = {
        "id": f"vk:{handle}",
        "platform": "vk",
        "handle": handle,
        "name": name,
        "title": name,
        "avatar": group.get("photo_200") or group.get("photo_100") or "",
        "banner": banner or "",
        "bio": (group.get("description") or "").strip(),
        "url": profile_url("vk", handle),
        "location": "",
        "website": website,
        "joined": "",
        "verifiedType": "business" if group.get("verified") else None,
        "configured": False,
    }
    if group.get("members_count") is not None:
        profile["followers"] = group.get("members_count")
    if post_count is not None:
        profile["postsCount"] = post_count
        # wall.get counts copies and co-owned posts along with the community's own.
        profile["postsCountIncludesReposts"] = True
    owner = _owner_id(group)
    stored = str(feed.get("permanentId") or "")
    if owner and stored and owner != stored:
        account = False
    if account and owner:
        profile["permanentId"] = owner
        profile["account"] = True
    return profile


def parse(payload, feed: dict) -> dict:
    data = parse_json_loose(payload) if not isinstance(payload, dict) else payload
    response = data.get("response") if isinstance(data, dict) else None
    if not isinstance(response, dict):
        return {"posts": [], "profiles": []}
    people = _people(data)
    posts = []
    for item in response.get("items") or []:
        post = _one(item, feed, people)
        if post:
            posts.append(post)
    groups = [row for row in (response.get("groups") or []) if isinstance(row, dict)]
    group, account = _pick_group(groups, feed, response)
    profiles = [_profile(group, feed, response.get("count"), account)] if group else []
    return {"posts": posts, "profiles": profiles}


def parse_comments(payload, post: dict) -> list:
    data = parse_json_loose(payload) if not isinstance(payload, dict) else payload
    response = data.get("response") if isinstance(data, dict) else None
    if not isinstance(response, dict):
        return []
    people = _people(data)
    parent_id = str(post.get("statusId") or post.get("id") or "")
    handle = post.get("handle") or ""
    rows = []
    for item in response.get("items") or []:
        row = _comment(item, people, parent_id, handle)
        if row:
            rows.append(row)
    return rows


def _comment(item: dict, people: dict, parent_id: str, handle: str) -> dict | None:
    if not isinstance(item, dict) or item.get("id") is None:
        return None
    text, links = vk_text(item.get("text") or "")
    media, more, notes = _attachments(item.get("attachments") or [])
    if notes:
        text = (text + "\n" + "\n".join(notes)).strip()
    if not text and not media:
        return None
    author = _person(people, item.get("from_id"))
    thread = item.get("thread") if isinstance(item.get("thread"), dict) else {}
    children = []
    for child in thread.get("items") or []:
        parsed = _comment(child, people, str(item.get("id")), author.get("handle") or handle)
        if parsed:
            children.append(parsed)
    try:
        reply_count = int(thread.get("count") or len(children) or 0)
    except (TypeError, ValueError):
        reply_count = len(children)
    try:
        likes = int((item.get("likes") or {}).get("count") or 0)
    except (TypeError, ValueError):
        likes = 0
    owner = item.get("owner_id")
    post_id = item.get("post_id")
    comment_id = item.get("id")
    url = f"https://vk.com/wall{owner}_{post_id}?reply={comment_id}" if owner is not None and post_id is not None else ""
    row = post_shell(
        id=str(comment_id),
        statusId=str(comment_id),
        platform="vk",
        kind="reply",
        author=author.get("name") or author.get("handle") or "",
        handle=author.get("handle") or "",
        avatar=author.get("avatar") or "",
        text=text,
        links=links + more,
        date=to_iso(item.get("date")),
        url=url,
        media=media,
        replyingTo={"id": parent_id, "handle": handle},
        stats={"likes": likes, "replies": reply_count},
    )
    if children:
        row["replies"] = children
    return row
