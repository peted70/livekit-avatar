variable "location" {
  description = "Azure region. Germany West Central sits close to the LiveKit Cloud project's region."
  type        = string
  default     = "germanywestcentral"
}

variable "prefix" {
  description = "Name prefix for all resources."
  type        = string
  default     = "avatarbhv"
}

variable "image_tag" {
  description = "Tag of the agent and web images in ACR (set by deploy.sh)."
  type        = string
}

variable "livekit_url" {
  type = string
}

variable "livekit_api_key" {
  type      = string
  sensitive = true
}

variable "livekit_api_secret" {
  type      = string
  sensitive = true
}

variable "apps_location" {
  description = "Region for the Container Apps environment. Separate from location because regions run out of Container Apps capacity (germanywestcentral did on first deploy)."
  type        = string
  default     = "swedencentral"
}
