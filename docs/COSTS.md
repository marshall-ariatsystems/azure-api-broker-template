# Cost profiles

The default **Essentials** profile uses two scale-to-zero Flex Consumption apps, one Storage account, one Standard Key Vault, and a shared Log Analytics/Application Insights pair. It has no APIM, NAT Gateway, dedicated plan, App Configuration store, VNet, or private endpoints.

The default burst ceiling is 10 broker instances plus 5 admin instances at 2 GiB each (15 cores total). Always-ready instances default to zero. Azure Monitor ingestion and retention are the main usage-sensitive cost controls.

The planned **Private** profile adds VNet integration, private endpoints, private DNS, and optional App Configuration. Those resources introduce fixed hourly charges and must be selected explicitly; public access must never be disabled until every required private dependency path has been validated.
