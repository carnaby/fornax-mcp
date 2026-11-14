import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from speakers import DIARIZE_MODEL, assign_speakers, normalize_diarization, normalize_transcript, without_words  # noqa: E402


def seg(start, end, text, words=None):
    s = {"start_ms": start, "end_ms": end, "text": text}
    if words is not None:
        s["words"] = [{"start_ms": a, "end_ms": b, "text": t} for a, b, t in words]
    return s


def turn(start, end, speaker):
    return {"start_ms": start, "end_ms": end, "speaker": speaker}


class NormalizeTranscript(unittest.TestCase):
    def test_cleans_rounds_sorts_and_drops_empty_texts(self):
        raw = {
            "language": "sk",
            "duration_ms": 4200.4,
            "segments": [
                {"start_ms": 2000.6, "end_ms": 3000, "text": "  second\n line ", "words": [{"start_ms": 2000, "end_ms": 1999, "text": " a "}, {"start_ms": "x", "end_ms": 1, "text": "b"}]},
                {"start_ms": 0, "end_ms": 900, "text": "first"},
                {"start_ms": 950, "end_ms": 990, "text": "   "},
                {"start_ms": -5, "end_ms": 10, "text": "early"},
            ],
        }
        t = normalize_transcript(raw)
        self.assertEqual(t["language"], "sk")
        self.assertEqual(t["duration_ms"], 4200)
        self.assertEqual(
            t["segments"],
            [
                {"start_ms": 0, "end_ms": 900, "text": "first"},
                {"start_ms": 0, "end_ms": 10, "text": "early"},
                {"start_ms": 2001, "end_ms": 3000, "text": "second line", "words": [{"start_ms": 2000, "end_ms": 2000, "text": "a"}]},
            ],
        )

    def test_unknown_language_and_duration_become_none(self):
        t = normalize_transcript({"language": "", "duration_ms": 0, "segments": []})
        self.assertEqual((t["language"], t["duration_ms"]), (None, None))

    def test_refuses_output_without_segments(self):
        with self.assertRaises(ValueError):
            normalize_transcript({"language": "en"})
        with self.assertRaises(ValueError):
            normalize_transcript([])


class NormalizeDiarization(unittest.TestCase):
    def test_keeps_turns_with_a_length_and_a_speaker(self):
        d = normalize_diarization({"model": "m", "turns": [turn(0, 500.4, "A"), turn(600, 600, "B"), turn(700, 900, ""), turn(-3, 10, "C")]})
        self.assertEqual(d, {"model": "m", "turns": [turn(0, 500, "A"), turn(0, 10, "C")]})

    def test_an_odd_model_name_is_replaced(self):
        self.assertEqual(normalize_diarization({"model": "x\ny", "turns": []})["model"], DIARIZE_MODEL)

    def test_refuses_output_without_turns(self):
        with self.assertRaises(ValueError):
            normalize_diarization({"model": "m"})


class AssignSpeakers(unittest.TestCase):
    def test_no_turns_gives_segments_without_speakers_or_words(self):
        r = assign_speakers([seg(0, 900, "hello", [(0, 400, "hello")])], [])
        self.assertEqual(r, {"segments": [{"start_ms": 0, "end_ms": 900, "text": "hello"}], "speakers": 0})

    def test_a_segment_of_one_speaker_keeps_whispers_text_and_times(self):
        r = assign_speakers([seg(0, 900, "hello world", [(0, 400, "hello"), (500, 900, "world")])], [turn(0, 1000, "A")])
        self.assertEqual(r["segments"], [{"start_ms": 0, "end_ms": 900, "text": "hello world", "speaker": "S1"}])

    def test_a_segment_is_split_where_the_speaker_changes(self):
        r = assign_speakers([seg(0, 900, "hello world", [(0, 400, "hello"), (500, 900, "world")])], [turn(0, 450, "A"), turn(450, 1000, "B")])
        self.assertEqual(
            r,
            {
                "segments": [
                    {"start_ms": 0, "end_ms": 400, "text": "hello", "speaker": "S1"},
                    {"start_ms": 500, "end_ms": 900, "text": "world", "speaker": "S2"},
                ],
                "speakers": 2,
            },
        )

    def test_a_word_near_a_turn_takes_its_speaker(self):
        r = assign_speakers([seg(0, 300, "one", [(100, 300, "one")]), seg(1200, 1300, "two", [(1200, 1300, "two")])], [turn(0, 500, "A"), turn(3000, 4000, "B")])
        self.assertEqual([s["speaker"] for s in r["segments"]], ["S1", "S1"])

    def test_a_word_far_from_every_turn_continues_the_previous_speaker(self):
        r = assign_speakers([seg(4100, 4200, "one", [(4100, 4200, "one")]), seg(2000, 2100, "two", [(2000, 2100, "two")])], [turn(0, 500, "A"), turn(4000, 5000, "B")])
        self.assertEqual([s["speaker"] for s in r["segments"]], ["S1", "S1"])
        self.assertEqual(r["speakers"], 1)

    def test_equal_overlaps_go_to_the_earlier_turn(self):
        r = assign_speakers([seg(400, 600, "x", [(400, 600, "x")])], [turn(500, 1000, "B"), turn(0, 500, "A")])
        self.assertEqual(r["segments"][0]["speaker"], "S1")
        r2 = assign_speakers([seg(400, 600, "x", [(400, 600, "x")]), seg(2000, 2500, "y", [(2000, 2500, "y")])], [turn(500, 1000, "B"), turn(0, 500, "A"), turn(1900, 2600, "B")])
        self.assertEqual([s["speaker"] for s in r2["segments"]], ["S1", "S2"])

    def test_speakers_are_numbered_by_their_first_line(self):
        r = assign_speakers([seg(0, 100, "a", []), seg(200, 300, "b", [])], [turn(0, 150, "SPEAKER_07"), turn(150, 400, "SPEAKER_00")])
        self.assertEqual([s["speaker"] for s in r["segments"]], ["S1", "S2"])

    def test_a_segment_without_words_gets_the_speaker_who_overlaps_it_most(self):
        r = assign_speakers([seg(0, 1000, "a")], [turn(0, 300, "A"), turn(300, 1000, "B")])
        self.assertEqual(r["segments"], [{"start_ms": 0, "end_ms": 1000, "text": "a", "speaker": "S1"}])
        self.assertEqual(r["speakers"], 1)


class WithoutWords(unittest.TestCase):
    def test_drops_words_and_empty_speakers(self):
        self.assertEqual(
            without_words([{"start_ms": 0, "end_ms": 1, "text": "a", "words": [], "speaker": None}, {"start_ms": 1, "end_ms": 2, "text": "b", "speaker": "S1"}]),
            [{"start_ms": 0, "end_ms": 1, "text": "a"}, {"start_ms": 1, "end_ms": 2, "text": "b", "speaker": "S1"}],
        )


if __name__ == "__main__":
    unittest.main()
