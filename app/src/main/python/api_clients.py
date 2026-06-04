"""
Lagani HTTP klijenti za Anthropic (Claude) i Groq (Whisper) preko stdlib `urllib`.

Razlog: na Androidu (Chaquopy) želimo NULA native zavisnosti osim lxml-a (za
python-docx). Zato NE koristimo `anthropic` SDK ni `httpx` — sve ide preko
`urllib.request`, koji je dio standardne biblioteke i radi svuda.

Funkcije vraćaju iste oblike podataka koje server.py očekuje (response.content[0].text
ekvivalent, usage tokeni, itd.) ali kao obične dict-ove.
"""
import json
import ssl
import uuid
import urllib.request
import urllib.error


# SSL kontekst sa CA bundle-om. Na Androidu (Chaquopy) sistemski CA store nije
# dostupan Python-u; koristimo certifi ako postoji, inače default kontekst.
def _make_ssl_context():
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        try:
            return ssl.create_default_context()
        except Exception:
            return None


_SSL_CTX = _make_ssl_context()


ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_VERSION = "2023-06-01"
GROQ_TRANSCRIBE_URL = "https://api.groq.com/openai/v1/audio/transcriptions"

DEFAULT_TIMEOUT = 90  # sekundi

# Cloudflare (ispred api.groq.com) blokira default "Python-urllib/x.y" User-Agent
# greškom 1010. Šaljemo realan UA da prođe bot-zaštitu.
USER_AGENT = (
    "Mozilla/5.0 (Linux; Android 15; SM-S938B) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36"
)


class ApiError(Exception):
    """Greška iz vanjskog API-ja. status = HTTP kod (ili 0 za mrežnu grešku)."""
    def __init__(self, status: int, message: str):
        self.status = status
        self.message = message
        super().__init__(f"[{status}] {message}")


# === Anthropic / Claude ===

def claude_messages(api_key: str, model: str, system, messages: list,
                    max_tokens: int = 2000, timeout: int = DEFAULT_TIMEOUT) -> dict:
    """Poziv Anthropic Messages API-ja.

    `system` može biti string ILI lista blokova (sa cache_control) — oboje validno.
    `messages` je lista poruka u Anthropic formatu (content može biti string ili
    lista blokova: text / image / document).

    Vraća dict:
      {
        "text": <spojen tekst svih text blokova odgovora>,
        "usage": {"input_tokens", "output_tokens", "cache_read", "cache_create"},
      }
    """
    payload = {
        "model": model,
        "max_tokens": max_tokens,
        "messages": messages,
    }
    if system:
        payload["system"] = system

    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(ANTHROPIC_URL, data=data, method="POST")
    req.add_header("content-type", "application/json")
    req.add_header("x-api-key", api_key)
    req.add_header("anthropic-version", ANTHROPIC_VERSION)
    req.add_header("User-Agent", USER_AGENT)

    try:
        with urllib.request.urlopen(req, timeout=timeout, context=_SSL_CTX) as resp:
            body = resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:500]
        raise ApiError(e.code, f"Anthropic: {detail}")
    except urllib.error.URLError as e:
        raise ApiError(0, f"Mrežna greška (Anthropic): {e.reason}")

    obj = json.loads(body)
    # Spoji sve text blokove iz content niza
    parts = []
    for block in obj.get("content", []):
        if block.get("type") == "text":
            parts.append(block.get("text", ""))
    text = "".join(parts).strip()

    usage = obj.get("usage", {}) or {}
    return {
        "text": text,
        "usage": {
            "input_tokens": usage.get("input_tokens", 0),
            "output_tokens": usage.get("output_tokens", 0),
            "cache_read": usage.get("cache_read_input_tokens", 0) or 0,
            "cache_create": usage.get("cache_creation_input_tokens", 0) or 0,
        },
    }


# === Groq / Whisper ===

def _build_multipart(fields: dict, file_field: str, filename: str,
                     file_bytes: bytes, file_content_type: str):
    """Sastavi multipart/form-data telo ručno. Vraća (body_bytes, content_type_header)."""
    boundary = "----DiktafonBoundary" + uuid.uuid4().hex
    crlf = b"\r\n"
    out = []

    for name, value in fields.items():
        out.append(b"--" + boundary.encode())
        out.append(crlf)
        out.append(f'Content-Disposition: form-data; name="{name}"'.encode())
        out.append(crlf)
        out.append(crlf)
        out.append(str(value).encode("utf-8"))
        out.append(crlf)

    out.append(b"--" + boundary.encode())
    out.append(crlf)
    out.append(
        f'Content-Disposition: form-data; name="{file_field}"; filename="{filename}"'.encode()
    )
    out.append(crlf)
    out.append(f"Content-Type: {file_content_type}".encode())
    out.append(crlf)
    out.append(crlf)
    out.append(file_bytes)
    out.append(crlf)

    out.append(b"--" + boundary.encode() + b"--")
    out.append(crlf)

    body = b"".join(out)
    return body, f"multipart/form-data; boundary={boundary}"


def groq_transcribe(api_key: str, audio_bytes: bytes, filename: str,
                    content_type: str, model: str = "whisper-large-v3",
                    language: str = "hr", prompt: str = "", temperature: str = "0",
                    timeout: int = DEFAULT_TIMEOUT) -> str:
    """Transkribuj audio preko Groq Whisper API-ja. Vraća sirovi transkript (string)."""
    fields = {
        "model": model,
        "language": language,
        "response_format": "json",
        "temperature": temperature,
    }
    if prompt:
        fields["prompt"] = prompt

    body, ct_header = _build_multipart(
        fields, "file", filename, audio_bytes, content_type or "audio/webm"
    )

    req = urllib.request.Request(GROQ_TRANSCRIBE_URL, data=body, method="POST")
    req.add_header("Authorization", f"Bearer {api_key}")
    req.add_header("Content-Type", ct_header)
    req.add_header("User-Agent", USER_AGENT)

    try:
        with urllib.request.urlopen(req, timeout=timeout, context=_SSL_CTX) as resp:
            raw = resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:500]
        raise ApiError(e.code, f"Groq: {detail}")
    except urllib.error.URLError as e:
        raise ApiError(0, f"Mrežna greška (Groq): {e.reason}")

    obj = json.loads(raw)
    return (obj.get("text") or "").strip()
