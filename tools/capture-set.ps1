# Captures the full critic shot set. Run from project root with dev server on :5187.
$ErrorActionPreference = 'Continue'
New-Item -ItemType Directory -Force shots | Out-Null

# Distance is auto-fitted from each rig's height in photo mode; the per-species
# camera bearing varies so ten portraits aren't ten identical postcards.
$pals = @(
  @{ id = 'emberfox';   a = 35 },
  @{ id = 'aquaxol';    a = 70 },
  @{ id = 'sproutle';   a = 110 },
  @{ id = 'sparkit';    a = 150 },
  @{ id = 'frostwing';  a = 195 },
  @{ id = 'boulderpup'; a = 235 },
  @{ id = 'galebird';   a = 275 },
  @{ id = 'umbrakit';   a = 310 },
  @{ id = 'lumimoth';   a = 20 },
  @{ id = 'drakelet';   a = 60 }
)

foreach ($p in $pals) {
  node tools/screenshot.mjs "shots/pal-$($p.id).png" "photo=1&hud=0&pal=$($p.id)&a=$($p.a)" 1200 900 7000
}

# Vistas + hero + HUD
node tools/screenshot.mjs shots/vista.png "photo=1&hud=0&cam=14,10,20&look=0,6,-6" 1600 900 9000
node tools/screenshot.mjs shots/vista-low.png "photo=1&hud=0&cam=-8,3,12&look=4,9,-14" 1600 900 9000
node tools/screenshot.mjs shots/hero-front.png "photo=1&hud=0&cam=0.9,1.6,3.2&look=0,1.1,0" 1200 900 7000
node tools/screenshot.mjs shots/gameplay-hud.png "play=1" 1600 900 9000

Get-ChildItem shots | Select-Object Name, LastWriteTime
