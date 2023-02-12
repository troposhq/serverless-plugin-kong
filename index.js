const Kong = require('@tropos/kong-admin-api-client');

class ServerlessPlugin {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;
    this.kong = null;

    this.hooks = {
      'after:deploy:deploy': this.afterDeployFunctions.bind(this),
    };
  }

  /**
   * @description hook to after deployment
   *
   * @return {Promise}
   */

  async afterDeployFunctions() {
    this.stage = this.serverless.service.provider.stage || 'dev';
    this.region = this.serverless.service.provider.region || 'us-east-1';
    this.providerName = this.serverless.service.provider.name;

    const defaultConfig = (this.serverless.config.serverless.service.custom || {}).kong || {};
    const defaultLambdaConfig = (defaultConfig.lambda || {}).config || {};
    const defaultVirtualService = defaultConfig.virtual_service || {};
    const detaultBasePath = defaultVirtualService.base_path || '';

    this.kong = new Kong({ adminAPIURL: defaultConfig.admin_api_url || 'http://localhost:8001' });

    // Create a Virtual Service for Lambda Functions
    const serviceName = defaultVirtualService.name || this.serverless.configurationInput.service
    const serviceUrl = defaultVirtualService.url || 'http://localhost:8000'

    const service = await this.kong.services.createOrUpdate(serviceName, {
      url: serviceUrl,
    });

    // get the current routes in Kong
    const existingRoutes = [];
    const newRoutes = [];
    let next = null;
    do {
      const result = await this.listRoutes();
      existingRoutes.push(...result.data);
      next = result.next; // eslint-disable-line
    } while (next !== null);

    const functions = Object.keys(this.serverless.service.functions)
      .map(key => this.serverless.service.functions[key]);

    for (const f of functions) {
      const kongEvents = f.events.filter(e => e.kong !== undefined).map(x => x.kong);

      for (const event of kongEvents) {
        // construct config for the aws-lambda plugin
        const eventLambdaConfig = (event.lambda || {}).config || {};
        const lambdaConfig = Object.assign(
          {},
          { aws_region: this.region, function_name: f.name },
          defaultLambdaConfig,
          eventLambdaConfig,
        );

        // create the route and add the aws-lambda plugin
        let routeToAdd = await this.addBasePathToRoute(event.route, detaultBasePath)

        const route = await this.createRoute(service, routeToAdd);
        await this.addLambdaPlugin(route, lambdaConfig);

        // add any other specified plugins
        const plugins = event.plugins || [];
        for (const plugin of plugins) {
          await this.addPluginToRoute(route, plugin);
        }
        // add name to new routes
        route.name = f.name
        newRoutes.push(route)
      }
    }

    // delete the old routes
    for (const r of existingRoutes) {
      await this.kong.routes.delete(r.id);
    }
    // update route name
    for (const newRoute of newRoutes) {
      await this.updateRouteName(newRoute, newRoute.name)
    }
  }

  createRoute(service, event) {
    return this.kong.routes.create({
      service: { id: service.id },
      ...event.route,
    });
  }

  addLambdaPlugin(route, config) {
    return this.kong.routes.addPlugin({
      routeId: route.id,
      name: 'aws-lambda',
      config,
      enabled: true,
    });
  }

  addPluginToRoute(route, plugin) {
    return this.kong.routes.addPlugin({
      routeId: route.id,
      ...plugin,
    });
  }

  updateRouteName(route, routeName) {
    return this.kong.routes.update(
      route.id,
      {name: routeName},
    );
  }

  listRoutes(offset) {
    return this.kong.routes.list({ serviceNameOrID: 'lambda-dummy-service', offset });
  }

  addBasePathToRoute(route, basePath) {
    const newPaths = [];
    for (const path of route.paths) {
      newPaths.push(basePath + path)
    }
    route.paths = newPaths
    return route
  }
}

module.exports = ServerlessPlugin;
