output "acr_name" {
  value = azurerm_container_registry.this.name
}

output "resource_group" {
  value = azurerm_resource_group.this.name
}

output "agent_app" {
  value = azurerm_container_app.agent.name
}

output "share_url" {
  description = "Link to send to testers (includes the access key)."
  value       = "https://${azurerm_container_app.web.ingress[0].fqdn}/?key=${random_password.access_key.result}"
  sensitive   = true
}
