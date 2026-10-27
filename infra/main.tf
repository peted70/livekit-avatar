resource "random_string" "suffix" {
  length  = 5
  special = false
  upper   = false
}

# Shared with testers in the link (?key=...), so random strangers can't mint tokens.
resource "random_password" "access_key" {
  length  = 20
  special = false
}

locals {
  name = "${var.prefix}-${random_string.suffix.result}"
}

resource "azurerm_resource_group" "this" {
  name     = "rg-${local.name}"
  location = var.location
}

resource "azurerm_log_analytics_workspace" "this" {
  name                = "log-${local.name}"
  location            = azurerm_resource_group.this.location
  resource_group_name = azurerm_resource_group.this.name
  sku                 = "PerGB2018"
  retention_in_days   = 30
}

resource "azurerm_container_registry" "this" {
  name                = replace("acr${local.name}", "-", "")
  location            = azurerm_resource_group.this.location
  resource_group_name = azurerm_resource_group.this.name
  sku                 = "Basic"
  admin_enabled       = false
}

# The apps pull images with this identity rather than registry admin credentials.
resource "azurerm_user_assigned_identity" "pull" {
  name                = "id-${local.name}-pull"
  location            = azurerm_resource_group.this.location
  resource_group_name = azurerm_resource_group.this.name
}

resource "azurerm_role_assignment" "pull" {
  scope                = azurerm_container_registry.this.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.pull.principal_id
}

resource "azurerm_container_app_environment" "this" {
  name                       = "cae-${local.name}"
  location                   = var.apps_location
  resource_group_name        = azurerm_resource_group.this.name
  log_analytics_workspace_id = azurerm_log_analytics_workspace.this.id
  logs_destination           = "log-analytics"
}

# The agent only makes outbound connections to LiveKit, so it has no ingress.
# One always-on replica keeps it registered; each room runs as a job inside it.
resource "azurerm_container_app" "agent" {
  name                         = "ca-${local.name}-agent"
  container_app_environment_id = azurerm_container_app_environment.this.id
  resource_group_name          = azurerm_resource_group.this.name
  revision_mode                = "Single"
  depends_on                   = [azurerm_role_assignment.pull]

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.pull.id]
  }

  registry {
    server   = azurerm_container_registry.this.login_server
    identity = azurerm_user_assigned_identity.pull.id
  }

  secret {
    name  = "livekit-api-key"
    value = var.livekit_api_key
  }

  secret {
    name  = "livekit-api-secret"
    value = var.livekit_api_secret
  }

  template {
    min_replicas = 1
    max_replicas = 1

    container {
      name  = "agent"
      image = "${azurerm_container_registry.this.login_server}/avatar-agent:${var.image_tag}"
      # STT/LLM/TTS run remotely, so the agent itself is light. It's always on, so size drives cost.
      cpu    = 0.5
      memory = "1Gi"

      env {
        name  = "LIVEKIT_URL"
        value = var.livekit_url
      }
      env {
        name        = "LIVEKIT_API_KEY"
        secret_name = "livekit-api-key"
      }
      env {
        name        = "LIVEKIT_API_SECRET"
        secret_name = "livekit-api-secret"
      }
    }
  }
}

resource "azurerm_container_app" "web" {
  name                         = "ca-${local.name}-web"
  container_app_environment_id = azurerm_container_app_environment.this.id
  resource_group_name          = azurerm_resource_group.this.name
  revision_mode                = "Single"
  depends_on                   = [azurerm_role_assignment.pull]

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.pull.id]
  }

  registry {
    server   = azurerm_container_registry.this.login_server
    identity = azurerm_user_assigned_identity.pull.id
  }

  secret {
    name  = "livekit-api-key"
    value = var.livekit_api_key
  }

  secret {
    name  = "livekit-api-secret"
    value = var.livekit_api_secret
  }

  secret {
    name  = "access-key"
    value = random_password.access_key.result
  }

  ingress {
    external_enabled = true
    target_port      = 8080

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    min_replicas = 0
    max_replicas = 2

    container {
      name   = "web"
      image  = "${azurerm_container_registry.this.login_server}/avatar-web:${var.image_tag}"
      cpu    = 0.25
      memory = "0.5Gi"

      env {
        name  = "LIVEKIT_URL"
        value = var.livekit_url
      }
      env {
        name        = "LIVEKIT_API_KEY"
        secret_name = "livekit-api-key"
      }
      env {
        name        = "LIVEKIT_API_SECRET"
        secret_name = "livekit-api-secret"
      }
      env {
        name        = "ACCESS_KEY"
        secret_name = "access-key"
      }

      liveness_probe {
        transport = "HTTP"
        port      = 8080
        path      = "/healthz"
      }
    }
  }
}
