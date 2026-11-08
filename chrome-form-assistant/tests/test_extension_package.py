"""Verify the actual unpacked directory, including Chrome reserved-name rules."""
import json
from pathlib import Path
import unittest


class ExtensionPackage(unittest.TestCase):
    def test_browser_directory_contains_only_runtime_assets(self):
        root = Path(__file__).resolve().parents[1]
        extension = root / 'extension'
        expected = {'manifest.json', 'background.js', 'content.js',
                    'sidepanel.html', 'sidepanel.js', 'style.css', 'local-api.js', 'catalog-worker.js', 'url-utils.js', 'autofill.js', 'products.json'}
        expected.update({'ahrefs-capture.js','blog-capture.js','semrush-capture.js','link-risk.js'})
        expected.update({'blog-queue.js','discovery-workflow.js','library-workflow.js','target-context.js','page-collection.js'})
        expected.update(f'icon{size}.png' for size in (16, 32, 48, 128))
        self.assertEqual({p.name for p in extension.iterdir()}, expected)
        self.assertFalse((root / 'manifest.json').exists())
        for path in extension.rglob('*'):
            self.assertTrue(path.is_file())
            self.assertFalse(path.name.startswith('_'), path.name)
            self.assertFalse(path.is_symlink(), path.name)
        manifest = json.loads((extension / 'manifest.json').read_text())
        self.assertEqual(manifest['manifest_version'], 3)
        for name in (manifest['background']['service_worker'],
                     manifest['side_panel']['default_path']):
            self.assertTrue((extension / name).is_file())
        self.assertNotIn('gateway.py', expected)
        self.assertEqual(manifest['host_permissions'], ['https://cubapi.codemao.cn/*'])
        self.assertEqual(manifest['optional_host_permissions'], ['https://*/*','http://*/*'])
        self.assertEqual(manifest['optional_permissions'], [])
        self.assertFalse((extension / 'resources.json').exists())
        self.assertFalse((extension / 'resources.json.gz').exists())
        products=json.loads((extension/'products.json').read_text())
        self.assertTrue(products['kits'])
        self.assertNotIn('llm',products)
        for path in extension.iterdir():
            self.assertNotIn('backlinks',path.name)

    def test_compact_ui_keeps_configuration_off_main_flow(self):
        root=Path(__file__).resolve().parents[1]/'extension'
        html=(root/'sidepanel.html').read_text()
        self.assertIn('<dialog id="settings">',html)
        self.assertIn('id="fillCurrent"',html)
        for obsolete in ('analyze','generate','fill','copy','resourceSearch','markSkipped'):
            self.assertNotIn(f'id="{obsolete}"',html)
        self.assertIn('id="cancelAuto" class="text-button" hidden',html)
        self.assertIn('id="tracking" hidden',html)



if __name__ == '__main__':
    unittest.main()
