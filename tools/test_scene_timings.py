"""Tests for scene timings: uv run --project agent pytest tools"""

from scene_script import parse
from scene_timings import caption_text, scene_line, tag_time, words
from scene_voice import VoicedLine

FRONT = "---\ncast:\n  host: { voice: a }\n  guest: { voice: b }\n---\n"


def alignment(text: str, step: float = 0.1) -> dict:
    """A fake alignment: every character takes `step` seconds."""
    return {
        "characters": list(text),
        "character_start_times_seconds": [i * step for i in range(len(text))],
        "character_end_times_seconds": [(i + 1) * step for i in range(len(text))],
    }


def test_caption_text_drops_audio_tags():
    assert caption_text("[laughs] Don't worry, [pause] you're fine.") == "Don't worry, you're fine."


def test_words_skip_audio_tags_even_with_spaces_inside():
    text = "Oh [clears throat] hi there"
    ws = words(alignment(text))
    assert [w["text"] for w in ws] == ["Oh", "hi", "there"]
    assert ws[1]["start"] == round(0.1 * text.index("hi"), 3)
    assert ws[2]["end"] == round(0.1 * len(text), 3)


def test_tag_time_is_the_next_spoken_character_or_the_end():
    a = alignment("Hi. Bye.")
    assert tag_time(a, 0) == 0.0
    assert tag_time(a, 3) == 0.4  # on the space: skips to "B"
    assert abs(tag_time(a, 8) - 0.8) < 1e-9  # end of line: as the last character ends


def test_scene_line_times_events_and_clamps_to_the_audio():
    line = parse(FRONT + "guest: [emotion:amused] [laughs] Don't worry, [gesture:point@host] you're fine. [gesture:nod]").lines[0]
    a = alignment(line.text)
    out = scene_line(VoicedLine(line, "001-guest.mp3", duration=3.0, alignment=a, loudness_before=-20, gain=0))
    assert out["text"] == "Don't worry, you're fine."
    assert [w["text"] for w in out["words"]] == ["Don't", "worry,", "you're", "fine."]
    ev = {e["msg"]["name"]: e for e in out["events"]}
    assert ev["amused"]["t"] == 0.0
    assert ev["point"]["t"] == round(0.1 * line.text.index("you're"), 3)
    assert ev["point"]["msg"] == {"type": "gesture", "name": "point", "target": "host"}
    assert ev["nod"]["t"] == 3.0  # the alignment runs past the 3s of audio
