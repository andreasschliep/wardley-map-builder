import copy
import unittest
from pathlib import Path

from wardley_map import MapValidationError, load_map, stage_names, validate_map

ROOT = Path(__file__).resolve().parent.parent
MAPS = ROOT / "maps"


def minimal_map():
    return {
        "title": "Minimal",
        "components": [
            {"id": "user", "name": "User", "evolution": 0.5, "value": 0.9},
            {"id": "service", "name": "Service", "evolution": 0.4, "value": 0.5},
        ],
        "dependencies": [{"from": "user", "to": "service"}],
    }


class ExampleMapsTest(unittest.TestCase):
    def test_example_maps_are_valid(self):
        files = sorted(MAPS.glob("*.yaml"))
        self.assertGreaterEqual(len(files), 2)
        for path in files:
            with self.subTest(path=path.name):
                mapdef = load_map(path)
                self.assertTrue(mapdef["components"])

    def test_default_stage_names(self):
        self.assertEqual(stage_names(minimal_map())[0], "Genesis")
        self.assertEqual(len(stage_names(minimal_map())), 4)


class ValidationTest(unittest.TestCase):
    def assertProblem(self, mapdef, fragment):
        with self.assertRaises(MapValidationError) as ctx:
            validate_map(mapdef)
        joined = "\n".join(ctx.exception.problems)
        self.assertIn(fragment, joined)
        return ctx.exception

    def test_minimal_map_is_valid(self):
        validate_map(minimal_map())

    def test_not_a_mapping(self):
        self.assertProblem(["a", "list"], "must be a YAML mapping")

    def test_missing_components(self):
        self.assertProblem({"title": "Empty"}, "'components' must be a non-empty list")

    def test_evolution_out_of_range(self):
        mapdef = minimal_map()
        mapdef["components"][0]["evolution"] = 1.2
        self.assertProblem(mapdef, "component 'user'.evolution must be between 0 and 1, got 1.2")

    def test_value_must_be_a_number(self):
        mapdef = minimal_map()
        mapdef["components"][1]["value"] = "high"
        self.assertProblem(mapdef, "component 'service'.value must be a number between 0 and 1")

    def test_unknown_dependency_target(self):
        mapdef = minimal_map()
        mapdef["dependencies"].append({"from": "user", "to": "databse"})
        self.assertProblem(mapdef, "dependencies[1].to refers to unknown component 'databse'")

    def test_duplicate_component_id(self):
        mapdef = minimal_map()
        mapdef["components"].append(copy.deepcopy(mapdef["components"][0]))
        self.assertProblem(mapdef, "id 'user' is used more than once")

    def test_unknown_component_type(self):
        mapdef = minimal_map()
        mapdef["components"][0]["type"] = "service"
        self.assertProblem(mapdef, "type must be one of activity, practice, data, knowledge")

    def test_bad_colour(self):
        mapdef = minimal_map()
        mapdef["components"][0]["color"] = "red"
        self.assertProblem(mapdef, "must be a hex colour")

    def test_movement_must_stay_on_the_map(self):
        mapdef = minimal_map()
        mapdef["movements"] = [{"from": "user", "delta": 0.7}]
        self.assertProblem(mapdef, "ends at evolution 1.20, outside 0..1")

    def test_group_range_order(self):
        mapdef = minimal_map()
        mapdef["groups"] = [{"name": "G", "bounds": {"evolution": [0.6, 0.2], "value": [0.1, 0.3]}}]
        self.assertProblem(mapdef, "groups[0].bounds.evolution must have min < max")

    def test_stages_must_be_four(self):
        mapdef = minimal_map()
        mapdef["axes"] = {"x": {"stages": ["A", "B", "C"]}}
        self.assertProblem(mapdef, "exactly four stages")

    def test_note_position(self):
        mapdef = minimal_map()
        mapdef["notes"] = [{"text": "Hi", "position": "bottom"}]
        self.assertProblem(mapdef, "notes[0].position must be one of")

    def test_all_problems_are_reported_together(self):
        mapdef = minimal_map()
        mapdef["components"][0]["evolution"] = -0.1
        mapdef["dependencies"].append({"from": "nobody", "to": "service"})
        err = self.assertProblem(mapdef, "unknown component 'nobody'")
        self.assertEqual(len(err.problems), 2)
        self.assertIn("Invalid map definition", str(err))


if __name__ == "__main__":
    unittest.main()
