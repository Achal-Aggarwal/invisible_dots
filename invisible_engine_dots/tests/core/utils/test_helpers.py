from nanobot.utils import token_encoding
from nanobot.utils.helpers import (
    content_with_media_breadcrumbs,
    truncate_text_to_tokens,
)


def test_truncate_text_to_tokens_keeps_text_within_budget():
    text = "hello world " * 100

    result = truncate_text_to_tokens(text, 10_000)

    assert result == text


def test_truncate_text_to_tokens_truncates_over_budget(monkeypatch, byte_encoding):
    monkeypatch.setattr(token_encoding, "_encoding", byte_encoding)
    text = "word " * 1_000

    result = truncate_text_to_tokens(text, 50)

    assert result.endswith("\n... (truncated)")
    assert len(byte_encoding.encode_ordinary(result)) <= 50


def test_truncate_text_to_tokens_non_positive_budget_returns_text():
    text = "anything"

    assert truncate_text_to_tokens(text, 0) == text


def test_content_with_media_breadcrumbs_preserves_valid_paths():
    assert content_with_media_breadcrumbs(
        "user",
        "review these",
        ["/media/report.pdf", "/media/clip.mp4"],
    ) == (
        "review these\n"
        "[image: /media/report.pdf]\n"
        "[image: /media/clip.mp4]"
    )


def test_content_with_media_breadcrumbs_only_rewrites_plain_user_content():
    structured = [{"type": "text", "text": "hello"}]

    assert content_with_media_breadcrumbs(
        "assistant",
        "done",
        ["/media/output.png"],
    ) == "done"
    assert content_with_media_breadcrumbs(
        "user",
        structured,
        ["/media/input.png"],
    ) is structured

