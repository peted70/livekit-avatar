"""Tests for the scene script parser: uv run --project agent pytest tools"""

import pytest

from scene_script import ScriptError, parse

FRONT = """---
title: The interview
cast:
  host: { avatar: avatar.glb, voice: szjxFHBq49nokhN8LmLh }
  guest: { voice: CwhRBWXzGAHq8TQ4Fs17 }
---
"""


def one_line(row: str):
    return parse(FRONT + row).lines[0]


def test_front_matter():
    script = parse(FRONT + "host: Hello.")
    assert script.title == "The interview"
    assert list(script.cast) == ["host", "guest"]
    assert script.cast["host"].avatar == "avatar.glb"
    assert script.cast["guest"].avatar is None
    assert script.cast["guest"].voice == "CwhRBWXzGAHq8TQ4Fs17"


def test_lines_in_order_with_file_line_numbers():
    script = parse(FRONT + "host: Hi.\n\nguest: Hello.\n")
    assert [(l.number, l.speaker, l.text) for l in script.lines] == [(7, "host", "Hi."), (9, "guest", "Hello.")]


def test_behaviour_tags_come_out_and_remember_where_they_sat():
    line = one_line("host: [emotion:curious] So what made you start? [gesture:open_palm]")
    assert line.text == "So what made you start?"
    assert [(t.kind, t.name, t.offset) for t in line.tags] == [("emotion", "curious", 0), ("gesture", "open_palm", len(line.text))]


def test_tag_mid_line_points_at_the_next_word():
    line = one_line("guest: Honestly? [gesture:shrug] I got tired.")
    assert line.text == "Honestly? I got tired."
    assert line.text[line.tags[0].offset :] == "I got tired."


def test_audio_tags_stay_in_the_text():
    line = one_line("guest: [emotion:thinking] Honestly? [pause] I got [laughs] tired.")
    assert line.text == "Honestly? [pause] I got [laughs] tired."
    assert [t.name for t in line.tags] == ["thinking"]


def test_point_at_another_cast_member():
    tag = one_line("guest: That was him. [gesture:point@host]").tags[0]
    assert (tag.name, tag.target) == ("point", "host")


@pytest.mark.parametrize(
    "row, message",
    [
        ("narrator: Hello.", "isn't in the cast"),
        ("host: [emotion:furious] Hello.", "unknown emotion"),
        ("host: [gesture:wave] Hello.", "unknown gesture"),
        ("host: [gesture:point@nobody] Hello.", "isn't in the cast"),
        ("host: [gesture:point@host] Hello.", "can't point at themselves"),
        ("host: [gesture:nod@guest] Hello.", "only [gesture:point@...]"),
        ("host: [emotion:happy]", "nothing to say"),
        ("Just some words.", "expected 'speaker: text'"),
    ],
)
def test_mistakes_name_the_line(row, message):
    with pytest.raises(ScriptError, match=r"line 7: .*" + message.replace("[", r"\[").replace(".", r"\.")):
        parse(FRONT + row)


def test_needs_front_matter_and_a_voice():
    with pytest.raises(ScriptError, match="front matter"):
        parse("host: Hello.")
    with pytest.raises(ScriptError, match="needs a voice"):
        parse("---\ncast:\n  host: { avatar: a.glb }\n---\nhost: Hi.")
    with pytest.raises(ScriptError, match="no lines"):
        parse(FRONT)
