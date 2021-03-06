#!/usr/bin/env node

import sms = require('source-map-support');
sms.install();

import {
  samPrimitiveTypes,
} from './samData';

import * as awsData from './awsData';
import * as resourcesSpec from './resourcesSpec';

const mergeOptions = require('merge-options');


export function toAWSPrimitiveTypes(x: string): string[] {
    let awsPrimitiveTypes: string[] = [];
    switch(x.toLowerCase()) {
        case 'number':
            awsPrimitiveTypes = ['Integer', 'Long', 'Double'];
            break;
        case 'string':
            awsPrimitiveTypes = ['String', 'Timestamp'];
            break;
        case 'boolean':
            awsPrimitiveTypes = ['Boolean'];
            break;
        default:
            throw new Error(`Type "${x}" is incompatible with any AWS primitive types!`);
    };
    return awsPrimitiveTypes;
}

export function buildResourceProperty(propertyTypes: string[], isRequired=false) {
    let property: any;
    if (propertyTypes.length > 1) {
        property = resourcesSpec.makeProperty();
        property['Type'] = propertyTypes;
    } else {
        property = resourcesSpec.makeProperty(propertyTypes.pop()!);
    }
    property['Required'] = isRequired;
    return property as awsData.Property;
}


function resolveTypes(propertyDefinition: any, baseName?: string): string[] {
    let propertyTypes = [];

    // this has subtypes
    if (propertyDefinition.hasOwnProperty('anyOf')) {
        for (let propertyDefinitionType of propertyDefinition['anyOf']) {
            for (let subType of resolveTypes(propertyDefinitionType)) {
                propertyTypes.push(subType);
            }
        }
    }

    // this is a primitive or complex type
    if (propertyDefinition.hasOwnProperty('type')) {

        // primitive type
        // some property definitions may have multiple primitive types within type
        // therefore it's best to process type as an array
        let propertyDefinitionTypes: string[];
        if (Array.isArray(propertyDefinition['type'])) {
          propertyDefinitionTypes = propertyDefinition['type'];
        } else {
          propertyDefinitionTypes = [propertyDefinition['type']];
        }
        // process each primitive type
        for (let propertyDefinitionType of propertyDefinitionTypes) {
          if (!!~samPrimitiveTypes.indexOf(propertyDefinitionType)) {
            let propTypes = toAWSPrimitiveTypes(propertyDefinitionType);
            for (let propType of propTypes) {
                propertyTypes.push(propType);
            }
          }
        }

        // list type
        if (propertyDefinition['type'] == 'array') {
          if (propertyDefinition.hasOwnProperty('items')) {
            for (let subPropType of resolveTypes(propertyDefinition['items'])) {
              if (!!~samPrimitiveTypes.indexOf(subPropType)) {
                let subPropTypes = toAWSPrimitiveTypes(subPropType);
                for (let subPropType of subPropTypes) {
                    propertyTypes.push(`List<${subPropType}>`);
                }
              } else {
                propertyTypes.push(`List<${subPropType}>`);
              }
            }

          } else {
            propertyTypes.push('List<Json>');
          }
        }

        // map type
        if (propertyDefinition['type'] == 'object') {
            if (propertyDefinition.hasOwnProperty('patternProperties')) {
                let patternProperties = propertyDefinition['patternProperties'];
                let patternPropertiesKey = Object.keys(patternProperties)[0];
                let valueDefinitions = patternProperties[patternPropertiesKey];
                for (let subPropType of resolveTypes(valueDefinitions)) {
                    if (!!~samPrimitiveTypes.indexOf(subPropType)) {
                        let subPropTypes = toAWSPrimitiveTypes(subPropType);
                        for (let subPropType of subPropTypes) {
                            propertyTypes.push(`Map<${subPropType}>`);
                        }
                    } else {
                        propertyTypes.push(`Map<${subPropType}>`);
                    }
                }
            } else {
                propertyTypes.push('Json');
            }
        }

    }

    // this is a property type
    if (propertyDefinition.hasOwnProperty('$ref')) {
        propertyTypes.push(propertyDefinition['$ref'].split('/').pop());
    }

    // normalize property type names
    propertyTypes = propertyTypes.map((x: string) => x.replace(/\w*::\w*::\w*(\.)?/, ''));

    // if this is a parameterized type then format its' specializations accordingly
    if (!!baseName && (propertyTypes.length > 1)) {
        propertyTypes = propertyTypes.map((x) => `${baseName}<${x}>`);
    }

    return propertyTypes;
}

export function processDefinition(type: string, typeDef: any, awsResourcesSpec: any) {

    // create and register the type
    let typePropertyName = '';
    let typeProperties: any;
    let typeRequired: any;
    let typeAdditionalProperties: any;

    let resource: awsData.Type;

    if (resourcesSpec.isPropertyTypeFormat(type)) {
        resource = resourcesSpec.makePropertyTypeSpec();
        awsResourcesSpec['PropertyTypes'][type] = resource;
        typePropertyName = resourcesSpec.getPropertyTypePropertyName(type);
        typeProperties = typeDef['properties'];
        typeRequired = typeDef['required'];
    } else {
        resource = resourcesSpec.makeResourceTypeSpec();
        awsResourcesSpec['ResourceTypes'][type] = resource;
        typeProperties = typeDef['properties']['Properties']['properties'];
        typeRequired = typeDef['properties']['Properties']['required'];
        typeAdditionalProperties = typeDef['properties']['Properties']['additionalProperties'];
    }

    // process definition's properties
    if (!!typeProperties) {
        for (let propertyName of Object.keys(typeProperties)) {
            let propertyDef = typeProperties[propertyName];
            let propertyIsRequired = !!typeRequired ? !!~typeRequired.indexOf(propertyName) : false;

            let propertyTypes = [];
            // nested property type
            if (propertyDef.hasOwnProperty('properties')) {
                propertyTypes = [`${typePropertyName}.${propertyName}`];
                processDefinition(`${type}.${propertyName}`, propertyName, awsResourcesSpec);

            // direct or so it might seem ($ref ???)
            } else {
                propertyTypes = resolveTypes(propertyDef, `${typePropertyName}#${propertyName}`);
            }
            let resourceProperty = buildResourceProperty(propertyTypes, propertyIsRequired);
            resource['Properties'][propertyName] = resourceProperty;
            if (!!typeAdditionalProperties) {
                resource['AdditionalProperties'] = typeAdditionalProperties;
            }
        }
    }
}

export function samResourcesSpecification(samSchema: any, customSpecification: any): awsData.AWSResourcesSpecification {
    let awsResourcesSpec: awsData.AWSResourcesSpecification = {
        PropertyTypes: {},
        ResourceTypes: {}
    };

    // filter SAM schema to include just type definitions
    let samSchemaTypeDefinitions = Object.keys(samSchema['definitions']);
    samSchemaTypeDefinitions = samSchemaTypeDefinitions.filter((x) => !!~x.indexOf('::'));
    // process SAM schema type definitions
    for (let type of samSchemaTypeDefinitions) {
      let samSchemaDef = samSchema['definitions'][type];
      processDefinition(type, samSchemaDef, awsResourcesSpec);
    }
    // enhance with custom specification
    awsResourcesSpec = mergeOptions(awsResourcesSpec, customSpecification);

    return awsResourcesSpec;
};
