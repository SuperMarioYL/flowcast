# FlowCast demo tape — rendered to assets/demo.gif by .github/workflows/demo.yml
#
# Story (the narrative hook from the plan): replay a recorded login+export
# asset with zero LLM calls, then break a selector to simulate a site redesign
# and watch `replay --heal` re-locate it against the live DOM and finish.
#
# Render locally with: vhs docs/demo.tape   (https://github.com/charmbracelet/vhs)

Output assets/demo.gif

Set Shell "bash"
Set FontSize 18
Set Width 1200
Set Height 640
Set Padding 24
Set Theme "Catppuccin Mocha"

Type "# 1. Replay the bundled asset — zero LLM calls on the happy path"
Enter
Sleep 1s
Type "npx flowcast replay examples/login-and-export.flow.json"
Enter
Sleep 6s

Type "# 2. A site redesign renames the Login button — break its selector"
Enter
Sleep 1s
Type "sed -i 's/button\\[type=.submit.\\]/#old-login-button/' examples/login-and-export.flow.json"
Enter
Sleep 1s
Type "npx flowcast replay examples/login-and-export.flow.json"
Enter
Sleep 4s
Type "# ^ the click step now misses: 'Run with --heal to re-locate'"
Enter
Sleep 2s

Type "# 3. Self-heal: re-locate against the live DOM with YOUR LLM key, write it back"
Enter
Sleep 1s
Type "export FLOWCAST_LLM_API_KEY=sk-...   # your own key, no model bundled"
Enter
Type "npx flowcast replay examples/login-and-export.flow.json --heal"
Enter
Sleep 6s
Type "# ✓ healed, replayed, and the repaired selector is saved back to the asset"
Enter
Sleep 3s
