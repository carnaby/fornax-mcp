import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import tts_lib as lib  # noqa: E402
from tts_lib import Rejected  # noqa: E402


class ResolveTest(unittest.TestCase):
    def test_defaults(self):
        r = lib.resolve({"text": "Ahoj."}, None)
        self.assertEqual((r.model, r.voice, r.format, r.speed, r.text, r.text_file), ("piper", "lili", "mp3", 1.0, "Ahoj.", None))
        self.assertEqual(lib.resolve({"model": "omnivoice"}, "/in/text_file.md").voice, "klara")

    def test_one_text_exactly(self):
        with self.assertRaisesRegex(Rejected, r"^give the text parameter or a text_file, not both$"):
            lib.resolve({"text": "Ahoj."}, "/in/text_file.txt")
        with self.assertRaisesRegex(Rejected, r"neither was given$"):
            lib.resolve({}, "")
        with self.assertRaisesRegex(Rejected, r"neither was given$"):
            lib.resolve({"text": ""}, None)
        self.assertEqual(lib.resolve({"text": ""}, "/in/a.txt").text, None)

    def test_a_voice_must_belong_to_its_model(self):
        with self.assertRaisesRegex(Rejected, r"^piper has no voice peter; its voices: lili$"):
            lib.resolve({"text": "A.", "voice": "peter"}, None)
        with self.assertRaisesRegex(Rejected, r"^omnivoice has no voice lili; its voices: klara, peter$"):
            lib.resolve({"text": "A.", "model": "omnivoice", "voice": "lili"}, None)
        self.assertEqual(lib.resolve({"text": "A.", "model": "omnivoice", "voice": "peter"}, None).voice, "peter")

    def test_speed_and_format(self):
        r = lib.resolve({"text": "A.", "speed": 1.25, "format": "opus"}, None)
        self.assertEqual((r.speed, r.format), (1.25, "opus"))
        with self.assertRaises(Rejected):
            lib.resolve({"text": "A.", "speed": 3}, None)


class DecodeTest(unittest.TestCase):
    def test_a_bom_is_dropped_and_utf16_refused(self):
        self.assertEqual(lib.decode_text(bytes([0xEF, 0xBB, 0xBF]) + "Ďateľ.".encode("utf-8")), "Ďateľ.")
        with self.assertRaisesRegex(Rejected, r"^the text file is UTF-16; save it as UTF-8$"):
            lib.decode_text(bytes([0xFF, 0xFE]) + "A.".encode("utf-16-le"))
        with self.assertRaisesRegex(Rejected, r"^the text file is not UTF-8; save it as UTF-8$"):
            lib.decode_text("Ďateľ".encode("cp1250"))

    def test_normalize_composes_and_unifies_line_ends(self):
        decomposed = "d" + chr(0x30C) + "a"  # d + combining caron
        self.assertEqual(lib.normalize(decomposed + chr(13) + chr(10) + "b" + chr(13) + "c"), "ďa" + chr(10) + "b" + chr(10) + "c")


class MarkdownTest(unittest.TestCase):
    def test_marks_go_and_text_stays(self):
        md = chr(10).join([
            "# Ranný prehľad #",
            "Dnes je **sobota** a _pekne_ bude.",
            "> Citát z `kódu`.",
            "Pozri [stránku](https://example.com) a ![obrázok](a.png) koniec.",
            "snake_case ostane.",
        ])
        out = lib.paragraphs(lib.strip_markdown(md))
        self.assertEqual(out, [
            "Ranný prehľad",
            "Dnes je sobota a pekne bude. Citát z kódu. Pozri stránku a koniec. snake_case ostane.",
        ])

    def test_headings_and_list_items_are_paragraphs(self):
        md = chr(10).join(["## Úlohy", "- kúpiť mlieko", "- zavolať", "1. prvý bod", "Bežný text", "pokračuje."])
        self.assertEqual(lib.paragraphs(lib.strip_markdown(md)), ["Úlohy", "kúpiť mlieko", "zavolať", "1. prvý bod", "Bežný text pokračuje."])

    def test_a_line_starting_with_an_ordinal_continues_its_paragraph(self):
        self.assertEqual(lib.paragraphs(lib.strip_markdown("Stretnutie bude" + chr(10) + "5. mája o desiatej v zasadačke.")), ["Stretnutie bude 5. mája o desiatej v zasadačke."])
        self.assertEqual(lib.paragraphs(lib.strip_markdown("5. mája bude stretnutie.")), ["5. mája bude stretnutie."])

    def test_a_numbered_list_keeps_its_numbers_as_paragraphs(self):
        NL = chr(10)
        self.assertEqual(lib.paragraphs(lib.strip_markdown(NL.join(["Úlohy:", "", "1. kúpiť mlieko", "2. zavolať"]))), ["Úlohy:", "1. kúpiť mlieko", "2. zavolať"])
        self.assertEqual(lib.paragraphs(lib.strip_markdown(NL.join(["- jedna", "2. dve"]))), ["jedna", "2. dve"])

    def test_code_blocks_rules_and_tables(self):
        md = chr(10).join([
            "Pred.", "```python", "print('nie')", "```", "~~~", "ani toto", "~~~",
            "---", "| Deň | Teplota |", "|---|:---:|", "| pondelok | 5 |", "Po.",
        ])
        self.assertEqual(lib.paragraphs(lib.strip_markdown(md)), ["Pred.", "Deň, Teplota", "pondelok, 5", "Po."])

    def test_only_a_code_block_leaves_nothing(self):
        with self.assertRaisesRegex(Rejected, r"^there is nothing to speak: the text is empty without its Markdown marks$"):
            lib.prepare(chr(10).join(["```", "x = 1", "```"]), markdown=True)


class ChunkTest(unittest.TestCase):
    def test_paragraphs_join_lines_until_a_blank_line(self):
        self.assertEqual(lib.paragraphs("a" + chr(10) + "b  c" + chr(10) + "   " + chr(10) + "d"), ["a b c", "d"])

    def test_sentences_keep_their_punctuation_and_quotes(self):
        p = "Prvá veta. Druhá? „Tretia!“ Štvrtá… piata (vnútri.) koniec"
        self.assertEqual(lib.sentences(p), ["Prvá veta.", "Druhá?", "„Tretia!“", "Štvrtá…", "piata (vnútri.)", "koniec"])

    def test_sentences_join_into_chunks_of_at_most_400(self):
        sentence = "Toto je jedna dlhšia veta s niekoľkými slovami navyše."  # 54 characters
        p = " ".join([sentence] * 20)
        out = lib.chunks(p)
        self.assertTrue(all(len(c) <= lib.CHUNK_CHARS for c in out), [len(c) for c in out])
        self.assertEqual(" ".join(out), p)
        self.assertEqual(len(out), 3)

    def test_a_long_sentence_is_cut_after_a_comma(self):
        s = "slovo " * 50 + "a tu je čiarka, " + "ďalšie " * 40 + "koniec."
        out = lib.split_long(s.strip())
        self.assertTrue(all(len(c) <= lib.CHUNK_CHARS for c in out))
        self.assertTrue(out[0].endswith("čiarka,"), out[0][-20:])
        self.assertEqual(" ".join(out).split(), s.split())

    def test_a_long_sentence_without_punctuation_is_cut_at_spaces(self):
        s = " ".join(f"slovo{i}" for i in range(200))
        out = lib.chunks(s)
        self.assertTrue(all(len(c) <= lib.CHUNK_CHARS for c in out))
        self.assertEqual(" ".join(out).split(), s.split())

    def test_a_word_longer_than_the_limit_is_cut_hard(self):
        out = lib.split_long("x" * 1000)
        self.assertEqual([len(c) for c in out], [400, 400, 200])


class PrepareTest(unittest.TestCase):
    def test_counts_and_shape(self):
        p = lib.prepare("Prvý odsek. Druhá veta." + chr(10) + chr(10) + "Druhý odsek.", markdown=False)
        self.assertEqual(p.paragraphs, [["Prvý odsek. Druhá veta."], ["Druhý odsek."]])
        self.assertEqual((p.characters, p.chunks), (23 + 12, 2))

    def test_whitespace_only_is_nothing_to_speak(self):
        with self.assertRaisesRegex(Rejected, r"^there is nothing to speak: the text is empty$"):
            lib.prepare("   ", markdown=False)

    def test_the_limit(self):
        lib.prepare("a" * lib.LIMIT_CHARS, markdown=False)
        with self.assertRaisesRegex(Rejected, r"^the text has 50001 characters and one job speaks at most 50000: split the text into several jobs$"):
            lib.prepare("a" * (lib.LIMIT_CHARS + 1), markdown=False)


if __name__ == "__main__":
    unittest.main()
