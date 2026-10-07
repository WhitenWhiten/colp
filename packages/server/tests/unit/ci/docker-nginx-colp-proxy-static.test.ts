import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'vitest';

const NGINX_CONF = new URL('../../../../devops/docker/nginx.conf', import.meta.url);
const REMOTE_SH = new URL('../../../../devops/lib/remote.sh', import.meta.url);

describe('web nginx COLP proxy', () => {
  test('proxies COLP manifest and /colp/ to the API instead of the SPA', async () => {
    const source = await readFile(NGINX_CONF, 'utf8');
    assert.match(source, /location = \/\.well-known\/collection-protocol/);
    assert.match(source, /location \/colp\//);
    assert.match(source, /location \/api\//);
    assert.match(source, /location = \/sitemap-reports\.xml/);
    assert.match(source, /location ~ \^\/reports\(\?:/);
    assert.match(source, /location = \/reports\/ \{ return 308 \/reports; \}/);
    assert.match(source, /location ~ \^\/reports\/\(\[\^\/\]\+\)\/issues\/\(\[\^\/\]\+\)\/\$ \{ return 308 \/reports\/\$1\/issues\/\$2; \}/);
    assert.match(source, /location ~ \^\/reports\/\(\[\^\/\]\+\)\/\$ \{ return 308 \/reports\/\$1; \}/);
    const spaIndex = source.indexOf('location / {');
    const colpIndex = source.indexOf('location /colp/');
    const manifestIndex = source.indexOf('location = /.well-known/collection-protocol');
    const apiIndex = source.indexOf('location /api/');
    const mcpIndex = source.indexOf('location = /collections/-/mcp {');
    const mcpCompatIndex = source.indexOf('location = /collections/-/mcp-compat {');
    const wellKnownMcpIndex = source.indexOf('location = /.well-known/mcp');
    const prmIndex = source.indexOf('location ^~ /.well-known/oauth-protected-resource');
    const asIndex = source.indexOf('location ^~ /.well-known/oauth-authorization-server');
    const reportsSitemapIndex = source.indexOf('location = /sitemap-reports.xml');
    const reportsPagesIndex = source.indexOf('location ~ ^/reports');
    const reportsRedirectIndex = source.indexOf('location = /reports/');
    assert.ok(
      colpIndex >= 0 &&
        manifestIndex >= 0 &&
        apiIndex >= 0 &&
        mcpIndex >= 0 &&
        mcpCompatIndex >= 0 &&
        wellKnownMcpIndex >= 0 &&
        prmIndex >= 0 &&
        asIndex >= 0 &&
        reportsSitemapIndex >= 0 &&
        reportsPagesIndex >= 0 &&
        spaIndex > colpIndex &&
        spaIndex > manifestIndex &&
        spaIndex > apiIndex &&
        spaIndex > mcpIndex &&
        spaIndex > mcpCompatIndex &&
        spaIndex > wellKnownMcpIndex &&
        spaIndex > prmIndex &&
        spaIndex > asIndex &&
        spaIndex > reportsSitemapIndex &&
        spaIndex > reportsPagesIndex &&
        spaIndex > reportsRedirectIndex,
      'COLP, MCP, mcp-compat, and /api/ locations must be declared before the SPA catch-all',
    );
    assert.match(source, /GET \/colp\/v0\.1\/sync\/collections/);
    assert.match(source, /proxy_read_timeout 3700s;/);
    assert.match(source, /try_files \$uri \$uri\/ =404;/);
    assert.doesNotMatch(source, /try_files \$uri \$uri\/ \/index\.html/);
  });

  test('serves GET /mcp as documentation and keeps POST /collections/-/mcp on the API', async () => {
    const source = await readFile(NGINX_CONF, 'utf8');
    assert.match(source, /location = \/mcp \{/);
    assert.match(source, /try_files \/mcp\.html =404;/);
    assert.match(source, /location = \/mcp\.md/);
    assert.match(source, /\/mcp\s+\/mcp\.md;/);
    const docsIndex = source.indexOf('location = /mcp {');
    const wireIndex = source.indexOf('location = /collections/-/mcp {');
    const compatIndex = source.indexOf('location = /collections/-/mcp-compat {');
    assert.ok(docsIndex >= 0 && wireIndex >= 0 && compatIndex >= 0 && docsIndex !== wireIndex);
    assert.ok(compatIndex !== wireIndex);
    const docsBlock = source.slice(docsIndex, source.indexOf('\n    }', docsIndex));
    assert.match(docsBlock, /try_files \/mcp\.html =404;/);
    assert.doesNotMatch(docsBlock, /proxy_pass/);
    const wireBlock = source.slice(wireIndex, source.indexOf('\n    }', wireIndex));
    assert.match(wireBlock, /proxy_pass/);
    assert.doesNotMatch(wireBlock, /mcp-compat/);
    const compatBlock = source.slice(compatIndex, source.indexOf('\n    }', compatIndex));
    assert.match(compatBlock, /proxy_pass/);
    assert.match(compatBlock, /proxy_read_timeout 3700s;/);
    assert.match(compatBlock, /proxy_buffering off;/);
  });

  test('host nginx template also proxies MCP and OAuth discovery to the API', async () => {
    const source = await readFile(REMOTE_SH, 'utf8');
    assert.match(source, /location = \/collections\/-\/mcp \{/);
    assert.match(source, /location = \/collections\/-\/mcp-compat \{/);
    assert.match(source, /location = \/\.well-known\/mcp/);
    assert.match(source, /location \^~ \/\.well-known\/oauth-protected-resource/);
    assert.match(source, /location \^~ \/\.well-known\/oauth-authorization-server/);
    assert.match(source, /location \^~ \/ready\//);
    assert.match(source, /proxy_read_timeout 3700s;/);
    assert.match(source, /proxy_buffering off;/);
    assert.match(source, /grep -q "location = \/collections\/-\/mcp-compat"/);
    const spaIndex = source.indexOf('location / {');
    const mcpIndex = source.indexOf('location = /collections/-/mcp {');
    const mcpCompatIndex = source.indexOf('location = /collections/-/mcp-compat {');
    const wellKnownMcpIndex = source.indexOf('location = /.well-known/mcp');
    assert.ok(spaIndex > mcpIndex && mcpIndex >= 0, 'host MCP location must be declared before location / {');
    assert.ok(
      spaIndex > mcpCompatIndex && mcpCompatIndex >= 0,
      'host mcp-compat location must be declared before location / {',
    );
    assert.ok(
      spaIndex > wellKnownMcpIndex && wellKnownMcpIndex >= 0,
      'host /.well-known/mcp location must be declared before location / {',
    );
  });

  test('host nginx template proxies report shell and dynamic sitemap before the web catch-all', async () => {
    const source = await readFile(REMOTE_SH, 'utf8');
    assert.match(source, /location = \/sitemap-reports\.xml/);
    assert.match(source, /location ~ \^\/reports\(\?:/);
    assert.match(source, /location = \/reports\/ \{ return 308 \/reports; \}/);
    assert.match(source, /location ~ \^\/reports\/\(\[\^\/\]\+\)\/issues\/\(\[\^\/\]\+\)\/\$ \{ return 308 \/reports\/\\\$1\/issues\/\\\$2; \}/);
    assert.match(source, /location ~ \^\/reports\/\(\[\^\/\]\+\)\/\$ \{ return 308 \/reports\/\\\$1; \}/);
    const sitemapIndex = source.lastIndexOf('location = /sitemap-reports.xml {');
    const reportIndex = source.lastIndexOf('location ~ ^/reports');
    const catchAll = source.lastIndexOf('location / {');
    assert.ok(sitemapIndex >= 0 && reportIndex >= 0 && catchAll > reportIndex);
    const sitemapBlock = source.slice(sitemapIndex, source.indexOf('\n    }', sitemapIndex));
    const reportBlock = source.slice(reportIndex, source.indexOf('\n    }', reportIndex));
    assert.match(sitemapBlock, /proxy_pass http:\/\/127\.0\.0\.1:\$\{api_port\}/u);
    assert.match(reportBlock, /proxy_pass http:\/\/127\.0\.0\.1:\$\{api_port\}/u);
  });
});
