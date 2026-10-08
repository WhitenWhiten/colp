/** Curated seed list. Exact hosts only; www is the sole automatic alias.
 * Add product subdomains explicitly: news.ycombinator.com is not ycombinator.com.
 * This is a maintenance list, not a traffic ranking or a claim of endorsement.
 */
const DOMAIN_SEEDS = `
youtube.com google.com arxiv.org bilibili.com zhihu.com news.ycombinator.com
wikipedia.org github.com gitlab.com bitbucket.org stackoverflow.com stackexchange.com
reddit.com quora.com medium.com substack.com dev.to hashnode.com hackerone.com
vercel.com netlify.com render.com railway.com fly.io heroku.com
amazon.com aws.amazon.com microsoft.com azure.microsoft.com cloud.google.com
apple.com developer.apple.com developer.android.com android.com kotlinlang.org
openai.com chatgpt.com platform.openai.com anthropic.com claude.ai gemini.google.com
huggingface.co replicate.com together.ai groq.com mistral.ai deepseek.com
perplexity.ai cohere.com ai.google.dev ai.meta.com ollama.com lmstudio.ai
cursor.com windsurf.com replit.com lovable.dev bolt.new v0.dev
notion.so notion.com obsidian.md logseq.com roamresearch.com anytype.io
linear.app trello.com asana.com clickup.com monday.com basecamp.com
slack.com discord.com telegram.org whatsapp.com signal.org zoom.us
meet.google.com teams.microsoft.com webex.com whereby.com loom.com
figma.com canva.com sketch.com framer.com webflow.com invisionapp.com
adobe.com behance.net dribbble.com artstation.com unsplash.com pexels.com pixabay.com
flickr.com pinterest.com instagram.com facebook.com threads.net x.com twitter.com
bsky.app mastodon.social tumblr.com linkedin.com tiktok.com snapchat.com
weibo.com weixin.qq.com qq.com douban.com xiaohongshu.com douyin.com kuaishou.com
baidu.com bing.com duckduckgo.com search.brave.com kagi.com ecosia.org startpage.com
yahoo.com yandex.com naver.com daum.net sogou.com so.com 360.cn
mail.google.com outlook.com proton.me tutanota.com fastmail.com zoho.com
icloud.com drive.google.com docs.google.com sheets.google.com slides.google.com
calendar.google.com maps.google.com translate.google.com photos.google.com
keep.google.com earth.google.com scholar.google.com books.google.com
dropbox.com box.com onedrive.live.com mega.nz pcloud.com sync.com backblaze.com
wetransfer.com send-anywhere.com nextcloud.com owncloud.com seafile.com
mozilla.org firefox.com brave.com opera.com vivaldi.com chromium.org torproject.org
ubuntu.com debian.org archlinux.org fedoraproject.org linuxmint.com opensuse.org
kernel.org linux.org freebsd.org openbsd.org netbsd.org gentoo.org nixos.org
alpinelinux.org kali.org tails.net pop.system76.com manjaro.org rockylinux.org
redhat.com suse.com canonical.com docker.com kubernetes.io podman.io containerd.io
helm.sh rancher.com istio.io envoyproxy.io cilium.io linkerd.io traefik.io
nginx.org apache.org caddyserver.com haproxy.org varnish-cache.org
python.org pypi.org docs.python.org anaconda.com conda.io jupyter.org
numpy.org scipy.org pandas.pydata.org matplotlib.org seaborn.pydata.org
scikit-learn.org pytorch.org tensorflow.org keras.io lightning.ai ray.io
opencv.org pillow.readthedocs.io sympy.org polars.rs duckdb.org dask.org
rust-lang.org crates.io docs.rs go.dev pkg.go.dev golang.org
nodejs.org npmjs.com deno.com bun.sh pnpm.io yarnpkg.com jsr.io
javascript.info typescriptlang.org developer.mozilla.org web.dev caniuse.com
w3.org whatwg.org w3schools.com freecodecamp.org codecademy.com exercism.org
react.dev nextjs.org vuejs.org nuxt.com svelte.dev angular.dev solidjs.com
astro.build remix.run qwik.dev preactjs.com lit.dev alpinejs.dev htmx.org
jquery.com backbonejs.org emberjs.com mithril.js.org stenciljs.com
vite.dev webpack.js.org rollupjs.org esbuild.github.io parceljs.org babeljs.io
eslint.org prettier.io biomejs.dev stylelint.io postcss.org lightningcss.dev
tailwindcss.com getbootstrap.com bulma.io foundation.zurb.com unocss.dev
mui.com ant.design chakra-ui.com mantine.dev radix-ui.com ui.shadcn.com
headlessui.com daisyui.com primevue.org vuetifyjs.com element-plus.org
storybook.js.org chromatic.com playwright.dev cypress.io selenium.dev
vitest.dev jestjs.io testing-library.com mocha.js.org jasmine.github.io
expressjs.com fastify.dev hono.dev nestjs.com koa.js.org adonisjs.com
fastapi.tiangolo.com djangoproject.com flask.palletsprojects.com starlette.io
rubyonrails.org ruby-lang.org rubygems.org sinatrarb.com hanamirb.org
php.net laravel.com symfony.com getcomposer.org wordpress.org drupal.org
java.com openjdk.org oracle.com spring.io quarkus.io micronaut.io
scala-lang.org clojure.org elixir-lang.org erlang.org hex.pm phoenixframework.org
haskell.org ocaml.org fsharp.org dotnet.microsoft.com nuget.org learn.microsoft.com
swift.org dart.dev flutter.dev reactnative.dev expo.dev ionicframework.com
capacitorjs.com electronjs.org tauri.app wails.io qt.io gtk.org wxwidgets.org
ziglang.org julialang.org r-project.org cran.r-project.org rstudio.com posit.co
lua.org luajit.org perl.org raku.org nim-lang.org vlang.io dlang.org
cplusplus.com cppreference.com isocpp.org boost.org cmake.org mesonbuild.com
llvm.org gcc.gnu.org gnu.org gdb.org valgrind.org sourceware.org
postgresql.org mysql.com mariadb.org sqlite.org mongodb.com redis.io
valkey.io keydb.dev memcached.org cassandra.apache.org couchdb.apache.org
cockroachlabs.com yugabyte.com tidb.io pingcap.com neon.tech supabase.com
planetscale.com turso.tech convex.dev firebase.google.com appwrite.io pocketbase.io
prisma.io drizzle.team typeorm.io sequelize.org knexjs.org kysely.dev
elastic.co opensearch.org meilisearch.com typesense.org algolia.com solr.apache.org
clickhouse.com snowflake.com databricks.com influxdata.com questdb.io timescale.com
grafana.com prometheus.io datadoghq.com newrelic.com sentry.io bugsnag.com
honeycomb.io openobserve.ai signoz.io opentelemetry.io jaegertracing.io zipkin.io
splunk.com sumologic.com loggly.com papertrail.com betterstack.com uptime.com
statuspage.io incident.io pagerduty.com opsgenie.com rootly.com checklyhq.com
terraform.io opentofu.org pulumi.com ansible.com chef.io puppet.com saltproject.io
packer.io vagrantup.com vaultproject.io consul.io nomadproject.io hashicorp.com
jenkins.io circleci.com travis-ci.com buildkite.com drone.io woodpecker-ci.org
argoproj.github.io fluxcd.io spinnaker.io tekton.dev dagger.io depot.dev
sonarqube.org snyk.io socket.dev dependabot.com renovatebot.com osv.dev
owasp.org nvd.nist.gov cve.org cisa.gov security.googleblog.com portswigger.net
letsencrypt.org ssl.com digicert.com sectigo.com zerossl.com keycloak.org
auth0.com clerk.com workos.com fusionauth.io zitadel.com ory.sh
okta.com onelogin.com 1password.com bitwarden.com keepass.info dashlane.com
lastpass.com nordpass.com enpass.io protonvpn.com mullvad.net tailscale.com
zerotier.com wireguard.com openvpn.net netbird.io ngrok.com localtunnel.me
postman.com insomnia.rest hoppscotch.io usebruno.com swagger.io stoplight.io
readme.com mintlify.com gitbook.com readthedocs.org docusaurus.io mkdocs.org
sphinx-doc.org vitepress.dev starlight.astro.build docsify.js.org slatejs.org
tiptap.dev lexical.dev quilljs.com prosemirror.net codemirror.net monaco-editor.github.io
yjs.dev automerge.org liveblocks.io partykit.io ably.com pusher.com
socket.io grpc.io graphql.org apollographql.com the-guild.dev trpc.io
buf.build connectrpc.com protobuf.dev capnproto.org flatbuffers.dev
kafka.apache.org rabbitmq.com nats.io pulsar.apache.org redpanda.com confluent.io
temporal.io inngest.com trigger.dev windmill.dev n8n.io zapier.com make.com
ifttt.com activepieces.com pipedream.com kestra.io prefect.io dagster.io
airflow.apache.org luigi.readthedocs.io mlflow.org wandb.ai comet.com neptune.ai
kaggle.com paperswithcode.com openreview.net semanticscholar.org connectedpapers.com
researchrabbit.ai scite.ai elicit.com consensus.app zotero.org mendeley.com
researchgate.net academia.edu orcid.org crossref.org doi.org pubmed.ncbi.nlm.nih.gov
ncbi.nlm.nih.gov biorxiv.org medrxiv.org ssrn.com osf.io zenodo.org figshare.com
nature.com science.org cell.com pnas.org plos.org frontiersin.org mdpi.com
sciencedirect.com springer.com link.springer.com wiley.com onlinelibrary.wiley.com
tandfonline.com sagepub.com jstor.org muse.jhu.edu cambridge.org academic.oup.com
ieee.org ieeexplore.ieee.org acm.org dl.acm.org aclanthology.org dblp.org
proceedings.neurips.cc icml.cc iclr.cc cv-foundation.org eccv.ecva.net aaai.org
mit.edu stanford.edu harvard.edu berkeley.edu caltech.edu princeton.edu yale.edu
columbia.edu cornell.edu cmu.edu uchicago.edu upenn.edu duke.edu nyu.edu
washington.edu gatech.edu ucla.edu ucsd.edu umich.edu illinois.edu purdue.edu
ox.ac.uk cam.ac.uk imperial.ac.uk ucl.ac.uk ed.ac.uk manchester.ac.uk
ethz.ch epfl.ch tum.de uni-heidelberg.de mpg.de inria.fr
ens.psl.eu sorbonne-universite.fr psl.eu univ-paris-saclay.fr
utoronto.ca ubc.ca mcgill.ca uwaterloo.ca ualberta.ca anu.edu.au
unimelb.edu.au sydney.edu.au unsw.edu.au monash.edu uq.edu.au
nus.edu.sg ntu.edu.sg smu.edu.sg sutd.edu.sg hku.hk cuhk.edu.hk ust.hk
pku.edu.cn tsinghua.edu.cn fudan.edu.cn sjtu.edu.cn zju.edu.cn ustc.edu.cn
nju.edu.cn ruc.edu.cn whu.edu.cn hust.edu.cn xjtu.edu.cn hit.edu.cn
bnu.edu.cn nankai.edu.cn tju.edu.cn tongji.edu.cn sysu.edu.cn scut.edu.cn
u-tokyo.ac.jp kyoto-u.ac.jp osaka-u.ac.jp tohoku.ac.jp nagoya-u.ac.jp
kaist.ac.kr snu.ac.kr postech.ac.kr yonsei.ac.kr korea.ac.kr
coursera.org edx.org udemy.com udacity.com khanacademy.org brilliant.org
pluralsight.com frontendmasters.com egghead.io scrimba.com datacamp.com dataquest.io
leetcode.com hackerrank.com codeforces.com atcoder.jp codechef.com topcoder.com
projecteuler.net adventofcode.com codingame.com codewars.com cs50.harvard.edu
ocw.mit.edu openstax.org open.edu futurelearn.com classcentral.com skillshare.com
duolingo.com memrise.com busuu.com babbel.com ankiweb.net quizlet.com
bbc.com bbc.co.uk cnn.com reuters.com apnews.com bloomberg.com ft.com
wsj.com nytimes.com washingtonpost.com theguardian.com economist.com npr.org
aljazeera.com dw.com france24.com euronews.com politico.com axios.com
propublica.org theatlantic.com newyorker.com time.com newsweek.com usatoday.com
cnbc.com businessinsider.com forbes.com fortune.com fastcompany.com inc.com
wired.com theverge.com arstechnica.com techcrunch.com engadget.com zdnet.com
cnet.com pcmag.com pcworld.com tomshardware.com anandtech.com techradar.com
9to5mac.com macrumors.com appleinsider.com androidauthority.com androidpolice.com
xda-developers.com gsmarena.com notebookcheck.net dpreview.com petapixel.com
36kr.com huxiu.com ithome.com sspai.com ifanr.com geekpark.net guokr.com
solidot.org v2ex.com juejin.cn csdn.net cnblogs.com segmentfault.com oschina.net
infoq.com infoq.cn 51cto.com runoob.com woshipm.com jianshu.com
xinhuanet.com people.com.cn chinadaily.com.cn cctv.com thepaper.cn caixin.com
reversinglabs.com schneier.com krebsonsecurity.com bleepingcomputer.com darkreading.com
spotify.com music.apple.com music.youtube.com soundcloud.com bandcamp.com tidal.com
deezer.com last.fm discogs.com musicbrainz.org genius.com musixmatch.com
netflix.com primevideo.com disneyplus.com hulu.com max.com peacocktv.com
paramountplus.com crunchyroll.com twitch.tv vimeo.com dailymotion.com nebula.tv
iqiyi.com youku.com v.qq.com mgtv.com music.163.com y.qq.com
imdb.com letterboxd.com rottentomatoes.com metacritic.com themoviedb.org trakt.tv
goodreads.com douban.com thestorygraph.com librarything.com openlibrary.org gutenberg.org
archive.org loc.gov bl.uk europeana.eu wikimedia.org commons.wikimedia.org
wikidata.org wiktionary.org wikisource.org wikibooks.org wikiquote.org wikivoyage.org
stackoverflow.blog blog.google engineering.fb.com netflixtechblog.com github.blog
store.steampowered.com steamcommunity.com epicgames.com gog.com itch.io humblebundle.com
nintendo.com playstation.com xbox.com ea.com ubisoft.com battle.net riotgames.com
unity.com unrealengine.com godotengine.org gamemaker.io defold.com bevy.org
blender.org krita.org gimp.org inkscape.org darktable.org rawtherapee.com
aseprite.org getpaint.net photopea.com penpot.app excalidraw.com tldraw.com draw.io
mermaid.js.org diagrams.net lucidchart.com miro.com whimsical.com eraser.io
geogebra.org desmos.com wolframalpha.com wolfram.com mathworks.com maple.com
overleaf.com latex-project.org typst.app pandoc.org quarto.org marktext.app
visualstudio.com code.visualstudio.com jetbrains.com neovim.io vim.org emacs.org
sublimetext.com zed.dev helix-editor.com notepad-plus-plus.org vscodium.com
git-scm.com mercurial-scm.org subversion.apache.org fossil-scm.org sourceforge.net
codeberg.org sr.ht gitea.com forgejo.org gitee.com gitcode.com
digitalocean.com linode.com vultr.com hetzner.com ovhcloud.com scaleway.com
akamai.com fastly.com bunny.net keycdn.com jsdelivr.com unpkg.com cdnjs.com
alibabacloud.com aliyun.com cloud.tencent.com huaweicloud.com volcengine.com ucloud.cn
namecheap.com porkbun.com gandi.net godaddy.com hover.com name.com
stripe.com paypal.com wise.com revolut.com squareup.com adyen.com checkout.com
paddle.com lemonsqueezy.com gumroad.com ko-fi.com buymeacoffee.com patreon.com
opencollective.com liberapay.com kickstarter.com indiegogo.com producthunt.com
indiehackers.com betalist.com alternativeto.net g2.com capterra.com trustpilot.com
shopify.com woocommerce.com bigcommerce.com squarespace.com wix.com ghost.org
etsy.com ebay.com aliexpress.com taobao.com tmall.com jd.com pinduoduo.com
rakuten.com mercadolibre.com shopee.com lazada.com walmart.com target.com
booking.com airbnb.com tripadvisor.com expedia.com agoda.com trip.com skyscanner.com
kayak.com rome2rio.com seat61.com flightradar24.com flightaware.com windy.com
weather.com accuweather.com weather.gov noaa.gov nasa.gov esa.int space.com
nationalgeographic.com smithsonianmag.com scientificamerican.com newscientist.com
livescience.com phys.org quantamagazine.org nautil.us aeon.co ourworldindata.org
gapminder.org worldbank.org imf.org un.org who.int unesco.org unicef.org oecd.org
statista.com data.gov data.europa.eu census.gov eurostat.ec.europa.eu
openstreetmap.org mapbox.com carto.com felt.com qgis.org arcgis.com
strava.com garmin.com alltrails.com komoot.com wikiloc.com openrouteservice.org
fitbit.com myfitnesspal.com healthline.com webmd.com mayoclinic.org clevelandclinic.org
`;

export const KNOWN_FAVICON_DOMAINS: readonly string[] = Object.freeze(
  [...new Set(DOMAIN_SEEDS.trim().split(/\s+/))].sort(),
);
const known = new Set(KNOWN_FAVICON_DOMAINS);

export function knownFaviconHostname(hostname: string): string | null {
  const normalized = hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  return known.has(normalized) ? normalized : null;
}

export function knownFaviconForUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return knownFaviconHostname(parsed.hostname);
  } catch { return null; }
}
