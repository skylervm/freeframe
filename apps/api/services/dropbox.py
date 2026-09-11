from urllib.parse import urlparse


def validate_dropbox_url(value: str | None) -> str | None:
    if value is None or value == "":
        return None
    if len(value) > 2048:
        raise ValueError("Dropbox URL must be 2048 characters or fewer")
    if "\\" in value or any(ord(char) < 33 or ord(char) > 126 for char in value):
        raise ValueError("Dropbox URL contains invalid characters")
    parsed = urlparse(value)
    if (
        parsed.scheme != "https"
        or parsed.netloc not in {"dropbox.com", "www.dropbox.com"}
        or parsed.username is not None
        or parsed.password is not None
        or (parsed.fragment and parsed.fragment.lower().startswith("javascript"))
    ):
        raise ValueError("Dropbox URL must be an https://dropbox.com URL")
    return value
