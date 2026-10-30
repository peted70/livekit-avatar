"""Tests for the scene writer's parts that don't call the model: uv run --project agent pytest tools"""

from pathlib import Path

import pytest

from scene_script import ScriptError, parse
from write_scene import assemble, describe, dialogue, load_brief, prompt

BRIEF = """---
title: Tech Corner
lines: 6
cast:
  pete: { avatar: avatar.glb, voice: abc, character: The host. Cheerful. }
  roger: { voice: def, character: Dry co-host. }
---
A mock tech news segment.
"""


@pytest.fixture
def brief(tmp_path: Path):
    path = tmp_path / "tech.md"
    path.write_text(BRIEF, encoding="utf-8")
    return load_brief(path)


def test_brief(brief):
    assert (brief.title, brief.lines, list(brief.cast)) == ("Tech Corner", 6, ["pete", "roger"])
    assert brief.premise == "A mock tech news segment."


def test_prompt_names_the_cast_and_the_tags(brief):
    p = prompt(brief)
    assert "- pete: The host. Cheerful." in p and "- roger: Dry co-host." in p
    assert "open_palm" in p and "surprised" in p and "[gesture:point@ID]" in p


def test_dialogue_keeps_only_cast_lines():
    reply = "```\n# Tech Corner\npete: [emotion:happy] Hi.\n\nroger: [emotion:amused] Hello.\n```\nHope that helps!"
    assert dialogue(reply) == ["pete: [emotion:happy] Hi.", "roger: [emotion:amused] Hello."]


def test_assembled_script_parses_and_drops_character_notes(brief):
    script = assemble(brief, ["pete: [emotion:happy] Hi.", "roger: [emotion:amused] [laughs] Hello. [gesture:point@pete]"])
    parsed = parse(script)
    assert parsed.title == "Tech Corner"
    assert parsed.cast["pete"].avatar == "avatar.glb" and parsed.cast["roger"].avatar is None
    assert "character" not in script
    assert [l.speaker for l in parsed.lines] == ["pete", "roger"]


def test_missing_premise(tmp_path: Path):
    path = tmp_path / "b.md"
    path.write_text(BRIEF.split("A mock")[0], encoding="utf-8")
    with pytest.raises(ScriptError, match="premise"):
        load_brief(path)


def test_a_mistake_goes_back_quoting_the_line(brief):
    script = assemble(brief, ["pete: [emotion:happy] Hi.", "roger: [gesture:wave] Hello."])
    with pytest.raises(ScriptError) as err:
        parse(script)
    assert describe(err.value, script) == (
        "This line has a mistake (unknown gesture 'wave' (one of nod, shake, open_palm, beat, point, shrug)): "
        "roger: [gesture:wave] Hello."
    )
